// Manual backfill endpoint for loading historical orders.
//
// Usage:
//   1. First call: GET /api/backfill
//      - Starts at status 4, page 1
//      - Pages through orders until 50 seconds elapsed or hit 30-day cutoff
//      - Returns progress + a "next" cursor
//   2. Subsequent calls: GET /api/backfill?status=4&page=5
//      - Resumes where the previous call stopped
//   3. Repeat until response says { "done": true }
//
// Each call processes as much as it can within ~50 seconds.
// Designed to stay within Vercel hobby 60s function limit.

import { NextRequest, NextResponse } from "next/server";
import { fetchOrdersPage, type MintsoftOrder } from "@/lib/mintsoft";
import { getOrder, upsertOrder, getClientName } from "@/lib/storage";
import type { StoredOrder } from "@/lib/storage";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS ?? 30);
const PAGE_SIZE = 200;
const MAX_RUNTIME_MS = 50_000; // leave 10s buffer under 60s limit

function normalizeMintsoftDate(s: string | null | undefined): string | null {
  if (!s) return null;
  try {
    let str = String(s);
    if (str.includes(" ") && !str.includes("T")) str = str.replace(" ", "T");
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

export async function GET(req: NextRequest) {
  const started = Date.now();

  // Statuses to backfill (orders that HAVE a DespatchDate)
  const statusIdsRaw = process.env.MINTSOFT_DISPATCHED_STATUSES || "4,5,6";
  const allStatuses = statusIdsRaw.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));

  // Resume cursor from query string
  const startStatus = Number(req.nextUrl.searchParams.get("status") ?? allStatuses[0]);
  const startPage = Number(req.nextUrl.searchParams.get("page") ?? 1);

  const cutoff = Date.now() - BACKFILL_DAYS * 24 * 3600 * 1000;

  // Client name cache (only fetch once per session)
  const clientNameCache = new Map<number, string | null>();
  async function clientNameFor(id: number | null | undefined): Promise<string | null> {
    if (!id) return null;
    if (clientNameCache.has(id)) return clientNameCache.get(id)!;
    const n = await getClientName(id);
    clientNameCache.set(id, n);
    return n;
  }

  // Find index of start status
  const startIdx = Math.max(0, allStatuses.indexOf(startStatus));
  const statusesToProcess = allStatuses.slice(startIdx);

  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkippedOld = 0;
  let nextStatus: number | null = null;
  let nextPage: number | null = null;
  let lastSeenOrderDate: string | null = null;
  let done = false;

  outer: for (let i = 0; i < statusesToProcess.length; i++) {
    const sid = statusesToProcess[i];
    let page = i === 0 ? startPage : 1;

    while (true) {
      // Time check before fetching next page
      if (Date.now() - started > MAX_RUNTIME_MS) {
        nextStatus = sid;
        nextPage = page;
        break outer;
      }

      let orders: MintsoftOrder[];
      try {
        orders = await fetchOrdersPage(sid, page, PAGE_SIZE);
      } catch (e: any) {
        // Skip status on error, move to next
        console.warn(`Status ${sid} page ${page} failed:`, e?.message);
        break;
      }

      if (orders.length === 0) {
        // End of pages for this status
        break;
      }

      totalFetched += orders.length;

      let allOldOnThisPage = true;
      for (const m of orders) {
        if (!m.ID) continue;
        if (!m.DespatchDate) continue;

        const orderDateStr = normalizeMintsoftDate(m.OrderDate);
        if (orderDateStr) lastSeenOrderDate = orderDateStr;

        // Date cutoff check
        if (orderDateStr) {
          const t = new Date(orderDateStr.includes("T") ? orderDateStr : orderDateStr.replace(" ", "T") + "Z").getTime();
          if (!Number.isNaN(t) && t >= cutoff) {
            allOldOnThisPage = false;
          } else if (!Number.isNaN(t) && t < cutoff) {
            totalSkippedOld += 1;
            continue;
          }
        } else {
          allOldOnThisPage = false;
        }

        const existing = await getOrder(m.ID);
        const cname = existing?.clientName ?? (await clientNameFor(m.ClientId));
        const stored = mintsoftToStored(m, existing, cname);
        if (!existing) {
          await upsertOrder(stored);
          totalInserted += 1;
        } else if (
          existing.despatchDate !== stored.despatchDate ||
          existing.trackingNumber !== stored.trackingNumber ||
          existing.orderStatus !== stored.orderStatus ||
          (cname && existing.clientName !== cname)
        ) {
          await upsertOrder(stored);
          totalUpdated += 1;
        }
      }

      // If every order on this page was older than the cutoff, stop paginating this status
      if (allOldOnThisPage) {
        break;
      }

      // If we got less than a full page, no more data for this status
      if (orders.length < PAGE_SIZE) {
        break;
      }

      page += 1;
    }
  }

  if (nextStatus === null) done = true;

  return NextResponse.json({
    done,
    next: done ? null : { status: nextStatus, page: nextPage },
    next_url: done ? null : `/api/backfill?status=${nextStatus}&page=${nextPage}`,
    fetched: totalFetched,
    inserted: totalInserted,
    updated: totalUpdated,
    skipped_older_than_cutoff: totalSkippedOld,
    last_seen_order_date: lastSeenOrderDate,
    duration_ms: Date.now() - started,
    backfill_days: BACKFILL_DAYS,
  });
}
