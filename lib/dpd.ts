// DPD Local tracking client - using the NEW customers API.
//
// Per Andy at DPD (2026-06-12):
//   1. Login: POST https://api.customers.dpd.co.uk/v1/customer/auth/access
//      with Basic auth (username:password) + "client-id" header (= DPD_API_KEY)
//      → returns accessToken
//   2. Track: POST https://api.customers.dpd.co.uk/v1/customer/parcel/tracking
//      with Authorization: Bearer <accessToken> + "client-id" header
//      Body: { parcelNumbers: [...] }

const BASE = process.env.DPD_BASE_URL || "https://api.customers.dpd.co.uk";

interface DPDSession {
  token: string;
  obtainedAt: number;
}

let cachedSession: DPDSession | null = null;
const SESSION_TTL_MS = 25 * 60 * 1000; // 25 minutes

async function getAccessToken(force = false): Promise<string> {
  const now = Date.now();
  if (!force && cachedSession && (now - cachedSession.obtainedAt) < SESSION_TTL_MS) {
    return cachedSession.token;
  }
  const username = process.env.DPD_USERNAME;
  const password = process.env.DPD_PASSWORD;
  const apiKey = process.env.DPD_API_KEY;
  if (!username || !password) throw new Error("DPD_USERNAME / DPD_PASSWORD not set");
  if (!apiKey) throw new Error("DPD_API_KEY not set (this is the client-id from the DPD developer portal)");

  const creds = Buffer.from(`${username}:${password}`).toString("base64");
  const headers: Record<string, string> = {
    "Authorization": `Basic ${creds}`,
    "client-id": apiKey,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };

  const res = await fetch(`${BASE}/v1/customer/auth/access`, {
    method: "POST",
    headers,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DPD auth/access failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const token =
    data?.data?.accessToken ??
    data?.accessToken ??
    data?.data?.geoSession ??
    data?.geoSession ??
    data?.access_token ??
    data?.token;
  if (!token) throw new Error(`DPD auth/access: no token in response: ${JSON.stringify(data).slice(0, 200)}`);
  cachedSession = { token, obtainedAt: now };
  return token;
}

export type DPDTrackingStatus = "delivered" | "in_transit" | "exception" | "not_found" | "pending";

export interface DPDTrackingResult {
  consignment: string;
  status: DPDTrackingStatus;
  deliveredAt: string | null;
  lastEvent: string | null;
}

const DELIVERED_KEYWORDS = ["delivered", "out for delivery completed", "consignment delivered"];

function parseDpdDateTime(s: string | null | undefined): string | null {
  if (!s) return null;
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function parseParcelResponse(p: any, fallbackConsignment: string): DPDTrackingResult {
  const events: any[] = p.trackingEvents ?? p.events ?? p.trackingEvent ?? [];
  let deliveredAt: string | null = null;
  let lastEvent: string | null = null;
  for (const ev of events) {
    const desc = (ev.status || ev.trackingEventStatus || ev.description || ev.trackingEventDescription || "").toLowerCase();
    if (!desc) continue;
    lastEvent = ev.status || ev.trackingEventStatus || ev.description || lastEvent;
    if (DELIVERED_KEYWORDS.some(kw => desc.includes(kw))) {
      const dt = parseDpdDateTime(ev.dateTime || ev.trackingEventDateTime || ev.eventDateTime);
      if (dt) deliveredAt = dt;
    }
  }
  if (!deliveredAt) {
    const dt = parseDpdDateTime(p.deliveredDateTime ?? p.deliveryDateTime ?? p?.deliveryDetails?.deliveredDateTime);
    if (dt) deliveredAt = dt;
  }

  const ts: string = (p.parcelStatus || p.status || p.trackingStatus || "").toLowerCase();
  let status: DPDTrackingStatus;
  if (deliveredAt) status = "delivered";
  else if (ts.includes("exception") || ts.includes("problem") || ts.includes("failed")) status = "exception";
  else if (ts) status = "in_transit";
  else status = "pending";

  const consignment = p.parcelNumber ?? p.consignmentNumber ?? p.trackingNumber ?? fallbackConsignment;
  return { consignment, status, deliveredAt, lastEvent: lastEvent ?? p.parcelStatus ?? p.status ?? null };
}

export async function trackDpd(consignment: string): Promise<DPDTrackingResult> {
  if (!consignment) {
    return { consignment, status: "not_found", deliveredAt: null, lastEvent: null };
  }

  const apiKey = process.env.DPD_API_KEY || "";

  for (const attempt of [1, 2]) {
    try {
      const token = await getAccessToken(attempt === 2);
      const res = await fetch(`${BASE}/v1/customer/parcel/tracking`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "client-id": apiKey,
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ parcelNumbers: [consignment] }),
        cache: "no-store",
      });

      if ((res.status === 401 || res.status === 403) && attempt === 1) {
        cachedSession = null;
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        return { consignment, status: "not_found", deliveredAt: null, lastEvent: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }

      let data: any;
      try { data = JSON.parse(text); } catch {
        return { consignment, status: "not_found", deliveredAt: null, lastEvent: "invalid JSON response" };
      }

      const parcels: any[] =
        data?.data?.parcels ??
        data?.parcels ??
        (Array.isArray(data?.data) ? data.data : []) ??
        [];

      if (parcels.length === 0) {
        return { consignment, status: "not_found", deliveredAt: null, lastEvent: "no parcels in response" };
      }
      return parseParcelResponse(parcels[0], consignment);
    } catch (e: any) {
      if (attempt === 2) {
        return { consignment, status: "not_found", deliveredAt: null, lastEvent: String(e?.message ?? e).slice(0, 200) };
      }
    }
  }
  return { consignment, status: "not_found", deliveredAt: null, lastEvent: "unreachable" };
}

export async function trackDpdBulk(consignments: string[]): Promise<Map<string, DPDTrackingResult>> {
  const out = new Map<string, DPDTrackingResult>();
  if (consignments.length === 0) return out;
  const unique = Array.from(new Set(consignments.filter(Boolean)));
  const apiKey = process.env.DPD_API_KEY || "";

  for (const attempt of [1, 2]) {
    try {
      const token = await getAccessToken(attempt === 2);
      const res = await fetch(`${BASE}/v1/customer/parcel/tracking`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "client-id": apiKey,
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ parcelNumbers: unique }),
        cache: "no-store",
      });

      if ((res.status === 401 || res.status === 403) && attempt === 1) {
        cachedSession = null;
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        for (const c of unique) {
          out.set(c, { consignment: c, status: "not_found", deliveredAt: null, lastEvent: `HTTP ${res.status}: ${text.slice(0, 100)}` });
        }
        return out;
      }

      const data = await res.json();
      const parcels: any[] =
        data?.data?.parcels ??
        data?.parcels ??
        (Array.isArray(data?.data) ? data.data : []) ??
        [];

      for (const p of parcels) {
        const num = p.parcelNumber ?? p.consignmentNumber ?? p.trackingNumber;
        if (!num) continue;
        out.set(num, parseParcelResponse(p, num));
      }
      for (const c of unique) {
        if (!out.has(c)) {
          out.set(c, { consignment: c, status: "not_found", deliveredAt: null, lastEvent: null });
        }
      }
      return out;
    } catch (e: any) {
      if (attempt === 2) {
        for (const c of unique) {
          out.set(c, { consignment: c, status: "not_found", deliveredAt: null, lastEvent: String(e?.message ?? e).slice(0, 200) });
        }
        return out;
      }
    }
  }
  return out;
}
