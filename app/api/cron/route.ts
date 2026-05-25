// Vercel cron endpoint - runs hourly.
//
// Strategy (designed to stay within Vercel free hobby limits):
//   1. Pull dispatched orders from Mintsoft (status=4), 1 page = 200 orders
//   2. Upsert into KV (only new orders or status changes get written)
//   3. For DPD orders without a delivered timestamp, query DPD tracking
//      (max 50 per cron run to keep within Vercel function timeout 10s on hobby)
//   4. Refresh client name cache occasionally

import { NextRequest, NextResponse } from "next/server";
import { fetchDispatchedOrders, fetchClients, type MintsoftOrder } from "@/lib/mintsoft";
import { trackDpd } from "@/lib/dpd";
import { warehouseSlaMet, deliverySlaMet, transitHours } from "@/lib/sla";
import {
  getOrder, upsertOrder, getAllOrders,
  setClientName, getClientName, getSyncState, setSyncState, isKvAvailable,
} from "@/lib/storage";
import type { StoredOrder } from "@/lib/storage";

// Vercel hobby plan: 10s default; pro: 60s. Cron jobs have 60s on hobby.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const DPD_TRACKING_BATCH = 30; // how many DPD lookups per cron run
const TRACKING_RECHECK_HOURS = 12; // re-check delivered orders this often (=> won't really refresh)

function isDpd(courier: string | null): boolean {
  return !!courier && courier.toLowerCase().includes("dpd");
}

function normalizeMintsoftDate(s: string | null | undefined): string | null {
  if (!s) return null;
  // Mintsoft returns "2026-05-25T08:26:46.123" or "2026-05-25 08:26:46"
  // We normalize to ISO without forcing a timezone (caller treats as UK local).
  try {
    let str = String(s);
    if (str.includes(" ") && !str.includes("T")) str = str.replace(" ", "T");
    // If trailing .NNN..., truncate to milliseconds
    const m = str.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?/);
    if (m) return m[2] ? `${m[1]}${m[2].slice(0, 4)}` : m[1];
    return str;
  } catch {
    return null;
  }
}

function mintsoftToStored(m: MintsoftOrder, existing: StoredOrder | null, clientName: string | null): StoredOrder {
  const now = new Date().toISOString();
  return {
    id: m.ID,
    orderNumber: m.OrderNumber ?? existing?.orderNumber ?? "",
    clientId: m.ClientId ?? existing?.clientId ?? 0,
    clientName: clientName ?? existing?.clientName ?? null,
    courierName: m.CourierServiceName ?? existing?.courierName ?? null,
    trackingNumber: m.TrackingNumber ?? existing?.trackingNumber ?? null,
    postcode: m.PostCode ?? existing?.postcode ?? null,
    countryCode: m.Country?.Code ?? existing?.countryCode ?? null,
    orderDate: normalizeMintsoftDate(m.OrderDate) ?? existing?.orderDate ?? "",
    despatchDate: normalizeMintsoftDate(m.DespatchDate) ?? existing?.despatchDate ?? null,
    deliveredDate: existing?.deliveredDate ?? null,
    orderStatus: m.OrderStatusId ?? existing?.orderStatus ?? 0,
    trackingStatus: existing?.trackingStatus ?? null,
    lastEvent: existing?.lastEvent ?? null,
    lastTrackingCheck: existing?.lastTrackingCheck ?? null,
    firstSeen: existing?.firstSeen ?? now,
    lastUpdated: now,
  };
}

async function syncMintsoftOrders(): Promise<{ fetched: number; inserted: number; updated: number }> {
  // Get list of dispatched orders
  const orders = await fetchDispatchedOrders({ pageSize: 200 });

  // Cache of client names looked up this run
  const clientNameCache = new Map<number, string | null>();
  async function clientNameFor(id: number | null | undefined): Promise<string | null> {
    if (!id) return null;
    if (clientNameCache.has(id)) return clientNameCache.get(id)!;
    const n = await getClientName(id);
    clientNameCache.set(id, n);
    return n;
  }

  let inserted = 0, updated = 0;
  for (const m of orders) {
    if (!m.ID) continue;
    const existing = await getOrder(m.ID);
    const cname = existing?.clientName ?? (await clientNameFor(m.ClientId));
    const stored = mintsoftToStored(m, existing, cname);
    // Did anything meaningful change?
    if (!existing) {
      await upsertOrder(stored);
      inserted += 1;
    } else if (
      existing.despatchDate !== stored.despatchDate ||
      existing.trackingNumber !== stored.trackingNumber ||
      existing.orderStatus !== stored.orderStatus ||
      (cname && existing.clientName !== cname)
    ) {
      await upsertOrder(stored);
      updated += 1;
    }
  }
  return { fetched: orders.length, inserted, updated };
}

async function refreshClients(): Promise<number> {
  // Refresh client name cache once per day (or first run)
  const last = await getSyncState("clients_last_refreshed");
  if (last) {
    const ageH = (Date.now() - new Date(last).getTime()) / 3_600_000;
    if (ageH < 24) return 0;
  }
  const clients = await fetchClients();
  for (const c of clients) {
    if (c.ID) await setClientName(c.ID, c.BrandName || c.Name || `Client ${c.ID}`);
  }
  await setSyncState("clients_last_refreshed", new Date().toISOString());
  return clients.length;
}

async function refreshDpdTracking(): Promise<{ checked: number; delivered: number; errors: number }> {
  const allOrders = await getAllOrders(2000);

  // Candidates: DPD courier, has tracking number, not yet delivered, dispatched in the last 14 days
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  const candidates = allOrders.filter(o => {
    if (!isDpd(o.courierName)) return false;
    if (!o.trackingNumber) return false;
    if (o.deliveredDate) return false;
    if (!o.despatchDate) return false;
    const d = new Date(o.despatchDate.includes("T") ? o.despatchDate : o.despatchDate.replace(" ", "T"));
    if (Number.isNaN(d.getTime())) return false;
    return d.getTime() >= cutoff;
  });

  // Prioritize never-checked first, then oldest check first
  candidates.sort((a, b) => {
    if (!a.lastTrackingCheck && !b.lastTrackingCheck) return 0;
    if (!a.lastTrackingCheck) return -1;
    if (!b.lastTrackingCheck) return 1;
    return new Date(a.lastTrackingCheck).getTime() - new Date(b.lastTrackingCheck).getTime();
  });

  const batch = candidates.slice(0, DPD_TRACKING_BATCH);
  let delivered = 0, errors = 0;
  for (const o of batch) {
    try {
      const result = await trackDpd(o.trackingNumber!);
      o.trackingStatus = result.status;
      o.lastEvent = result.lastEvent;
      o.lastTrackingCheck = new Date().toISOString();
      if (result.status === "delivered" && result.deliveredAt) {
        o.deliveredDate = result.deliveredAt;
        delivered += 1;
      }
      await upsertOrder(o);
    } catch (e) {
      errors += 1;
    }
    // Light throttle to avoid hitting DPD rate limits
    await new Promise(r => setTimeout(r, 150));
  }
  return { checked: batch.length, delivered, errors };
}

export async function GET(req: NextRequest) {
  // Vercel cron jobs are authenticated via a header. We also support manual
  // triggering with a query param ?key=<CRON_SECRET> for debugging.
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  const isVercelCron = auth === `Bearer ${cronSecret}`;
  const isManualWithKey = cronSecret && req.nextUrl.searchParams.get("key") === cronSecret;

  // Allow public access if no CRON_SECRET is set (initial setup convenience)
  if (cronSecret && !isVercelCron && !isManualWithKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const out: Record<string, any> = { kv: isKvAvailable() };

  try {
    out.clients_refreshed = await refreshClients();
  } catch (e: any) { out.clients_error = String(e?.message ?? e); }

  try {
    out.mintsoft = await syncMintsoftOrders();
  } catch (e: any) { out.mintsoft_error = String(e?.message ?? e); }

  try {
    out.dpd = await refreshDpdTracking();
  } catch (e: any) { out.dpd_error = String(e?.message ?? e); }

  // Compute SLA flags on all orders (cheap, in-memory)
  try {
    const orders = await getAllOrders(5000);
    out.total_orders = orders.length;
    out.with_delivery = orders.filter(o => o.deliveredDate).length;
  } catch (e: any) { out.aggregate_error = String(e?.message ?? e); }

  await setSyncState("last_run", new Date().toISOString());
  out.duration_ms = Date.now() - started;
  return NextResponse.json(out);
}
