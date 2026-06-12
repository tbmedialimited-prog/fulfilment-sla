// DPD Local tracking client.
//
// Per direct guidance from Andy Smith at DPD (2026-05-26):
//   1. Login: POST https://api.dpdlocal.co.uk/user/?action=login (Basic auth) -> geoSession
//   2. Track:  POST https://api.customers.dpd.co.uk/v1/customer/parcel/tracking
//              with the geoSession token, body specifies one of 4 search params.
//
// The 4 supported search parameters (per DPD API portal):
//   - parcelNumbers: array of parcel numbers (e.g. ["15976913071805"])
//   - customerReference + postcode: order ref + recipient postcode
//   - customerReference: just the order ref
//   - searchKey: their proprietary identifier
//
// We use parcelNumbers since we have those from Mintsoft.

const LOGIN_BASE = process.env.DPD_LOGIN_BASE || "https://api.dpdlocal.co.uk";
const TRACK_BASE = process.env.DPD_TRACK_BASE || "https://api.customers.dpd.co.uk";

interface DPDSession {
  token: string;
  obtainedAt: number;
}

let cachedSession: DPDSession | null = null;
const SESSION_TTL_MS = 25 * 60 * 1000;

async function getSession(force = false): Promise<string> {
  const now = Date.now();
  if (!force && cachedSession && (now - cachedSession.obtainedAt) < SESSION_TTL_MS) {
    return cachedSession.token;
  }
  const username = process.env.DPD_USERNAME;
  const password = process.env.DPD_PASSWORD;
  const accountNumber = process.env.DPD_ACCOUNT_NUMBER;
  if (!username || !password) throw new Error("DPD_USERNAME / DPD_PASSWORD not set");

  const creds = Buffer.from(`${username}:${password}`).toString("base64");
  const headers: Record<string, string> = {
    "Authorization": `Basic ${creds}`,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
  if (accountNumber) headers["GEOClient"] = `account/${accountNumber}`;

  const res = await fetch(`${LOGIN_BASE}/user/?action=login`, {
    method: "POST",
    headers,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DPD login failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const token = data?.data?.geoSession || data?.geoSession;
  if (!token) throw new Error(`DPD login: no geoSession in response`);
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
    const d = new Date(typeof s === "string" && !s.endsWith("Z") && !s.includes("+") ? s : s);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

/**
 * Track a single DPD parcel by its parcel number (14-digit tracking number).
 * Uses the endpoint Andy at DPD confirmed: api.customers.dpd.co.uk/v1/customer/parcel/tracking
 */
export async function trackDpd(consignment: string): Promise<DPDTrackingResult> {
  if (!consignment) {
    return { consignment, status: "not_found", deliveredAt: null, lastEvent: null };
  }

  for (const attempt of [1, 2]) {
    try {
      const session = await getSession(attempt === 2);
      const accountNumber = process.env.DPD_ACCOUNT_NUMBER;
      const headers: Record<string, string> = {
        "GEOSession": session,
        "Accept": "application/json",
        "Content-Type": "application/json",
      };
      if (accountNumber) headers["GEOClient"] = `account/${accountNumber}`;

      // Per DPD API portal, the tracking endpoint accepts the search params
      // as a POST body. We're using parcelNumbers as the lookup key.
      const body = JSON.stringify({
        parcelNumbers: [consignment],
      });

      const res = await fetch(`${TRACK_BASE}/v1/customer/parcel/tracking`, {
        method: "POST",
        headers,
        body,
        cache: "no-store",
      });

      // If unauthorized on first attempt, retry with a fresh session
      if ((res.status === 401 || res.status === 403) && attempt === 1) {
        cachedSession = null;
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        return {
          consignment,
          status: "not_found",
          deliveredAt: null,
          lastEvent: `HTTP ${res.status}: ${text.slice(0, 200)}`,
        };
      }

      let data: any;
      try { data = JSON.parse(text); } catch {
        return { consignment, status: "not_found", deliveredAt: null, lastEvent: "invalid JSON response" };
      }

      // Parse the response. DPD's tracking response shape (best guess, defensive parsing):
      // { data: { parcels: [{ trackingEvents: [{ status, dateTime, description }], status, deliveredDateTime }] } }
      const parcels: any[] =
        data?.data?.parcels ??
        data?.data?.parcel ??
        data?.parcels ??
        (Array.isArray(data?.data) ? data.data : []) ??
        [];

      if (parcels.length === 0) {
        return { consignment, status: "not_found", deliveredAt: null, lastEvent: "no parcels in response" };
      }
      const p = parcels[0];

      // Find delivery time from events
      const events: any[] = p.trackingEvents ?? p.events ?? p.trackingEvent ?? [];
      let deliveredAt: string | null = null;
      let lastEvent: string | null = null;
      for (const ev of events) {
        const desc = (ev.status || ev.trackingEventStatus || ev.description || ev.trackingEventDescription || "").toLowerCase();
        if (!desc) continue;
        lastEvent = ev.status || ev.trackingEventStatus || ev.description || lastEvent;
        if (DELIVERED_KEYWORDS.some(kw => desc.includes(kw))) {
          const dt = parseDpdDateTime(ev.dateTime || ev.trackingEventDateTime || ev.trackingEventDate);
          if (dt) deliveredAt = dt;
        }
      }

      // Fallback: top-level delivered timestamp
      if (!deliveredAt) {
        const dt = parseDpdDateTime(
          p.deliveredDateTime ??
          p.deliveryDateTime ??
          p?.deliveryDetails?.deliveredDateTime ??
          p?.deliveryDetails?.notificationDetails?.deliveredDateTime
        );
        if (dt) deliveredAt = dt;
      }

      const trackingStatus: string = (p.parcelStatus || p.status || p.trackingStatus || "").toLowerCase();
      let status: DPDTrackingStatus;
      if (deliveredAt) status = "delivered";
      else if (trackingStatus.includes("exception") || trackingStatus.includes("problem") || trackingStatus.includes("failed")) status = "exception";
      else if (trackingStatus) status = "in_transit";
      else status = "pending";

      return {
        consignment,
        status,
        deliveredAt,
        lastEvent: lastEvent ?? p.parcelStatus ?? p.status ?? null,
      };
    } catch (e: any) {
      if (attempt === 2) {
        console.warn(`DPD tracking failed for ${consignment}:`, e?.message);
        return {
          consignment,
          status: "not_found",
          deliveredAt: null,
          lastEvent: String(e?.message ?? e).slice(0, 200),
        };
      }
    }
  }
  return { consignment, status: "not_found", deliveredAt: null, lastEvent: "unreachable" };
}

/**
 * Bulk tracking — track multiple parcels in one API call.
 * Returns results keyed by consignment number.
 *
 * This is more efficient than calling trackDpd N times since DPD's API
 * accepts an array of parcel numbers in a single call.
 */
export async function trackDpdBulk(consignments: string[]): Promise<Map<string, DPDTrackingResult>> {
  const out = new Map<string, DPDTrackingResult>();
  if (consignments.length === 0) return out;

  // Strip duplicates and empties
  const unique = Array.from(new Set(consignments.filter(Boolean)));

  for (const attempt of [1, 2]) {
    try {
      const session = await getSession(attempt === 2);
      const accountNumber = process.env.DPD_ACCOUNT_NUMBER;
      const headers: Record<string, string> = {
        "GEOSession": session,
        "Accept": "application/json",
        "Content-Type": "application/json",
      };
      if (accountNumber) headers["GEOClient"] = `account/${accountNumber}`;

      const body = JSON.stringify({ parcelNumbers: unique });
      const res = await fetch(`${TRACK_BASE}/v1/customer/parcel/tracking`, {
        method: "POST",
        headers,
        body,
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

      // Index parcels by their parcel number for lookup
      for (const p of parcels) {
        const num = p.parcelNumber ?? p.consignmentNumber ?? p.trackingNumber;
        if (!num) continue;

        const events: any[] = p.trackingEvents ?? p.events ?? [];
        let deliveredAt: string | null = null;
        let lastEvent: string | null = null;
        for (const ev of events) {
          const desc = (ev.status || ev.description || "").toLowerCase();
          if (!desc) continue;
          lastEvent = ev.status || ev.description || lastEvent;
          if (DELIVERED_KEYWORDS.some(kw => desc.includes(kw))) {
            const dt = parseDpdDateTime(ev.dateTime || ev.eventDateTime);
            if (dt) deliveredAt = dt;
          }
        }
        if (!deliveredAt) {
          const dt = parseDpdDateTime(p.deliveredDateTime ?? p.deliveryDateTime);
          if (dt) deliveredAt = dt;
        }

        const ts: string = (p.parcelStatus || p.status || "").toLowerCase();
        let status: DPDTrackingStatus;
        if (deliveredAt) status = "delivered";
        else if (ts.includes("exception") || ts.includes("problem")) status = "exception";
        else if (ts) status = "in_transit";
        else status = "pending";

        out.set(num, { consignment: num, status, deliveredAt, lastEvent: lastEvent ?? p.parcelStatus ?? null });
      }

      // Anything not returned by DPD = not found
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
