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
// Convert anything Neon throws back (Date object, ISO string, "YYYY-MM-DD HH:MM:SS" string)
// into a stable ISO string. Neon's HTTP driver returns timestamps as strings.
function normalizeTs(v: any): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") {
    // "2026-05-25 08:26:46" -> "2026-05-25T08:26:46Z"
    let s = v;
    if (s.includes(" ") && !s.includes("T")) s = s.replace(" ", "T");
    if (!s.endsWith("Z") && !s.includes("+") && !s.match(/-\d\d:\d\d$/)) s = s + "Z";
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? v : d.toISOString();
  }
  try { return new Date(v).toISOString(); } catch { return null; }
}

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
    orderDate: normalizeTs(r.order_date) ?? "",
    despatchDate: normalizeTs(r.despatch_date),
    deliveredDate: normalizeTs(r.delivered_date),
    orderStatus: r.order_status ?? 0,
    trackingStatus: r.tracking_status ?? null,
    lastEvent: r.last_event ?? null,
    lastTrackingCheck: normalizeTs(r.last_tracking_check),
    firstSeen: normalizeTs(r.first_seen) ?? new Date().toISOString(),
    lastUpdated: normalizeTs(r.last_updated) ?? new Date().toISOString(),
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

export async function getAllOrders(limit = 1000): Promise<StoredOrder[]> {
  const q = getSql();
  if (!q) return Array.from(memOrders.values()).slice(0, limit);
  await ensureSchema();
  // Coerce limit to a safe positive integer and inline it directly into SQL.
  // Neon serverless driver's tagged-template mode has issues parameterizing LIMIT.
  const safeLimit = Math.max(1, Math.min(10000, Math.floor(Number(limit) || 1000)));
  const rows = await (q as any)(
    `SELECT * FROM orders ORDER BY order_date DESC NULLS LAST LIMIT ${safeLimit}`
  );
  return (rows as any[]).map(rowToOrder);
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
