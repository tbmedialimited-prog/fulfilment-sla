// Storage layer. Uses Neon Postgres via the @neondatabase/serverless driver.
// Vercel auto-injects DATABASE_URL when you connect a Neon DB to the project.
//
// Falls back to in-memory storage if DATABASE_URL is not set (handy for local dev).

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export interface StoredOrder {
  id: number;
  orderNumber: string;
  clientId: number;
  clientName: string | null;
  courierName: string | null;
  trackingNumber: string | null;
  postcode: string | null;
  countryCode: string | null;
  orderDate: string;       // ISO
  despatchDate: string | null;
  deliveredDate: string | null;
  orderStatus: number;
  trackingStatus: string | null;
  lastEvent: string | null;
  lastTrackingCheck: string | null; // ISO
  firstSeen: string;       // ISO
  lastUpdated: string;     // ISO
}

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const HAS_DB = !!DATABASE_URL;

let sql: NeonQueryFunction<false, false> | null = null;
function getSql() {
  if (!sql && HAS_DB) sql = neon(DATABASE_URL);
  return sql;
}

// Track schema initialization once per cold start
let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  const q = getSql();
  if (!q) return Promise.resolve();
  schemaReady = (async () => {
    await q`
      CREATE TABLE IF NOT EXISTS orders (
        id              BIGINT PRIMARY KEY,
        order_number    TEXT,
        client_id       INTEGER,
        client_name     TEXT,
        courier_name    TEXT,
        tracking_number TEXT,
        postcode        TEXT,
        country_code    TEXT,
        order_date      TIMESTAMP,
        despatch_date   TIMESTAMP,
        delivered_date  TIMESTAMP,
        order_status    INTEGER,
        tracking_status TEXT,
        last_event      TEXT,
        last_tracking_check TIMESTAMP,
        first_seen      TIMESTAMP DEFAULT NOW(),
        last_updated    TIMESTAMP DEFAULT NOW()
      )
    `;
    await q`CREATE INDEX IF NOT EXISTS orders_order_date_idx ON orders (order_date DESC)`;
    await q`CREATE INDEX IF NOT EXISTS orders_client_idx ON orders (client_id)`;
    await q`CREATE INDEX IF NOT EXISTS orders_courier_idx ON orders (courier_name)`;
    await q`
      CREATE TABLE IF NOT EXISTS clients (
        id   INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      )
    `;
    await q`
      CREATE TABLE IF NOT EXISTS sync_state (
        key   TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `;
  })();
  return schemaReady;
}

// ---- In-memory fallback ----
const memOrders = new Map<number, StoredOrder>();
const memClients = new Map<number, string>();
const memState = new Map<string, string>();

// ---- Helpers to convert row <-> StoredOrder ----
function rowToOrder(r: any): StoredOrder {
  return {
    id: Number(r.id),
    orderNumber: r.order_number ?? "",
    clientId: r.client_id ?? 0,
    clientName: r.client_name ?? null,
    courierName: r.courier_name ?? null,
    trackingNumber: r.tracking_number ?? null,
    postcode: r.postcode ?? null,
    countryCode: r.country_code ?? null,
    orderDate: r.order_date instanceof Date ? r.order_date.toISOString() : (r.order_date ?? ""),
    despatchDate: r.despatch_date instanceof Date ? r.despatch_date.toISOString() : (r.despatch_date ?? null),
    deliveredDate: r.delivered_date instanceof Date ? r.delivered_date.toISOString() : (r.delivered_date ?? null),
    orderStatus: r.order_status ?? 0,
    trackingStatus: r.tracking_status ?? null,
    lastEvent: r.last_event ?? null,
    lastTrackingCheck: r.last_tracking_check instanceof Date ? r.last_tracking_check.toISOString() : (r.last_tracking_check ?? null),
    firstSeen: r.first_seen instanceof Date ? r.first_seen.toISOString() : (r.first_seen ?? ""),
    lastUpdated: r.last_updated instanceof Date ? r.last_updated.toISOString() : (r.last_updated ?? ""),
  };
}

// Convert ISO string -> Date or null for SQL timestamps
function toDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---- Public API ----

export async function getOrder(id: number): Promise<StoredOrder | null> {
  const q = getSql();
  if (!q) return memOrders.get(id) ?? null;
  await ensureSchema();
  const rows = await q`SELECT * FROM orders WHERE id = ${id} LIMIT 1`;
  return rows.length ? rowToOrder(rows[0]) : null;
}

export async function upsertOrder(o: StoredOrder): Promise<void> {
  o.lastUpdated = new Date().toISOString();
  const q = getSql();
  if (!q) {
    memOrders.set(o.id, o);
    return;
  }
  await ensureSchema();
  await q`
    INSERT INTO orders (
      id, order_number, client_id, client_name, courier_name,
      tracking_number, postcode, country_code,
      order_date, despatch_date, delivered_date,
      order_status, tracking_status, last_event, last_tracking_check,
      first_seen, last_updated
    ) VALUES (
      ${o.id}, ${o.orderNumber}, ${o.clientId}, ${o.clientName}, ${o.courierName},
      ${o.trackingNumber}, ${o.postcode}, ${o.countryCode},
      ${toDate(o.orderDate)}, ${toDate(o.despatchDate)}, ${toDate(o.deliveredDate)},
      ${o.orderStatus}, ${o.trackingStatus}, ${o.lastEvent}, ${toDate(o.lastTrackingCheck)},
      ${toDate(o.firstSeen) ?? new Date()}, ${new Date()}
    )
    ON CONFLICT (id) DO UPDATE SET
      order_number    = EXCLUDED.order_number,
      client_id       = EXCLUDED.client_id,
      client_name     = COALESCE(EXCLUDED.client_name, orders.client_name),
      courier_name    = EXCLUDED.courier_name,
      tracking_number = COALESCE(EXCLUDED.tracking_number, orders.tracking_number),
      postcode        = COALESCE(EXCLUDED.postcode, orders.postcode),
      country_code    = COALESCE(EXCLUDED.country_code, orders.country_code),
      order_date      = COALESCE(EXCLUDED.order_date, orders.order_date),
      despatch_date   = COALESCE(EXCLUDED.despatch_date, orders.despatch_date),
      delivered_date  = COALESCE(EXCLUDED.delivered_date, orders.delivered_date),
      order_status    = EXCLUDED.order_status,
      tracking_status = COALESCE(EXCLUDED.tracking_status, orders.tracking_status),
      last_event      = COALESCE(EXCLUDED.last_event, orders.last_event),
      last_tracking_check = COALESCE(EXCLUDED.last_tracking_check, orders.last_tracking_check),
      last_updated    = NOW()
  `;
}

export async function getAllOrders(limit = 5000): Promise<StoredOrder[]> {
  const q = getSql();
  if (!q) return Array.from(memOrders.values()).slice(0, limit);
  await ensureSchema();
  const rows = await q`SELECT * FROM orders ORDER BY order_date DESC NULLS LAST LIMIT ${limit}`;
  return rows.map(rowToOrder);
}

export async function setClientName(id: number, name: string): Promise<void> {
  const q = getSql();
  if (!q) { memClients.set(id, name); return; }
  await ensureSchema();
  await q`
    INSERT INTO clients (id, name) VALUES (${id}, ${name})
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
  `;
}

export async function getClientName(id: number): Promise<string | null> {
  const q = getSql();
  if (!q) return memClients.get(id) ?? null;
  await ensureSchema();
  const rows = await q`SELECT name FROM clients WHERE id = ${id} LIMIT 1`;
  return rows.length ? (rows[0] as any).name : null;
}

export async function getSyncState(key: string): Promise<string | null> {
  const q = getSql();
  if (!q) return memState.get(key) ?? null;
  await ensureSchema();
  const rows = await q`SELECT value FROM sync_state WHERE key = ${key} LIMIT 1`;
  return rows.length ? (rows[0] as any).value : null;
}

export async function setSyncState(key: string, value: string): Promise<void> {
  const q = getSql();
  if (!q) { memState.set(key, value); return; }
  await ensureSchema();
  await q`
    INSERT INTO sync_state (key, value, updated_at) VALUES (${key}, ${value}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

export function isKvAvailable(): boolean {
  return HAS_DB;
}
