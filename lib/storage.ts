// Storage layer. Uses Vercel KV (Redis) when available, falls back to in-memory
// for local dev. KV is created in Vercel dashboard with one click.
//
// Schema:
//   order:<id>           -> JSON of stored order
//   order_ids            -> Set of all order IDs (for listing)
//   client:<id>          -> Client name
//   sync_state:last_run  -> ISO timestamp of last cron run

import { kv } from "@vercel/kv";

export interface StoredOrder {
  id: number;
  orderNumber: string;
  clientId: number;
  clientName: string | null;
  courierName: string | null;
  trackingNumber: string | null;
  postcode: string | null;
  countryCode: string | null;
  orderDate: string; // ISO from Mintsoft
  despatchDate: string | null;
  deliveredDate: string | null;
  orderStatus: number;
  trackingStatus: string | null;
  lastEvent: string | null;
  lastTrackingCheck: string | null; // ISO
  firstSeen: string; // ISO
  lastUpdated: string; // ISO
}

const KV_AVAILABLE = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

// In-memory fallback for local dev (when KV not configured)
const memOrders = new Map<number, StoredOrder>();
const memClients = new Map<number, string>();
const memState = new Map<string, string>();

export async function getOrder(id: number): Promise<StoredOrder | null> {
  if (KV_AVAILABLE) {
    return (await kv.get<StoredOrder>(`order:${id}`)) ?? null;
  }
  return memOrders.get(id) ?? null;
}

export async function upsertOrder(o: StoredOrder): Promise<void> {
  o.lastUpdated = new Date().toISOString();
  if (KV_AVAILABLE) {
    await kv.set(`order:${o.id}`, o);
    await kv.sadd("order_ids", String(o.id));
  } else {
    memOrders.set(o.id, o);
  }
}

export async function getAllOrders(limit = 5000): Promise<StoredOrder[]> {
  if (KV_AVAILABLE) {
    const idStrings = (await kv.smembers("order_ids")) ?? [];
    if (idStrings.length === 0) return [];
    // Fetch in batches of 100 (mget)
    const out: StoredOrder[] = [];
    const ids = idStrings.slice(0, limit);
    const CHUNK = 100;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const keys = ids.slice(i, i + CHUNK).map(id => `order:${id}`);
      const vals = await kv.mget<StoredOrder[]>(...keys);
      for (const v of vals) {
        if (v) out.push(v);
      }
    }
    return out;
  }
  return Array.from(memOrders.values()).slice(0, limit);
}

export async function setClientName(id: number, name: string): Promise<void> {
  if (KV_AVAILABLE) {
    await kv.set(`client:${id}`, name);
  } else {
    memClients.set(id, name);
  }
}

export async function getClientName(id: number): Promise<string | null> {
  if (KV_AVAILABLE) {
    return (await kv.get<string>(`client:${id}`)) ?? null;
  }
  return memClients.get(id) ?? null;
}

export async function getSyncState(key: string): Promise<string | null> {
  if (KV_AVAILABLE) {
    return (await kv.get<string>(`sync_state:${key}`)) ?? null;
  }
  return memState.get(key) ?? null;
}

export async function setSyncState(key: string, value: string): Promise<void> {
  if (KV_AVAILABLE) {
    await kv.set(`sync_state:${key}`, value);
  } else {
    memState.set(key, value);
  }
}

export function isKvAvailable(): boolean {
  return KV_AVAILABLE;
}
