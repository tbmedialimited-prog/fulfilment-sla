// DPD Local tracking client.
// Supports BOTH:
//   1. API key auth (if DPD_API_KEY env var is set)
//   2. Username/password -> geoSession auth (fallback)
//
// We try API key first since it's simpler. If it doesn't work, the username/password
// path is also wired up.

const DPD_BASE = process.env.DPD_BASE_URL || "https://api.dpdlocal.co.uk";

interface DPDSession {
  token: string;
  obtainedAt: number;
}

// In-memory session cache (per Vercel function instance)
let cachedSession: DPDSession | null = null;
const SESSION_TTL_MS = 25 * 60 * 1000; // 25 minutes (DPD sessions last 30)

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

  const res = await fetch(`${DPD_BASE}/user/?action=login`, {
    method: "POST",
    headers,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DPD login failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const token = (data?.data?.geoSession) || data?.geoSession;
  if (!token) throw new Error(`DPD login: no geoSession in response`);
  cachedSession = { token, obtainedAt: now };
  return token;
}

export type DPDTrackingStatus = "delivered" | "in_transit" | "exception" | "not_found" | "pending";

export interface DPDTrackingResult {
  consignment: string;
  status: DPDTrackingStatus;
  deliveredAt: string | null; // ISO
  lastEvent: string | null;
}

const DELIVERED_KEYWORDS = ["delivered", "out for delivery completed", "consignment delivered"];

function parseDpdDateTime(s: string | null | undefined): string | null {
  if (!s) return null;
  try {
    // DPD returns "2024-08-15T14:32:00" or similar. Treat as UTC if no tz.
    const cleaned = s.endsWith("Z") ? s : s.includes("+") || s.includes("T") ? s : s;
    const d = new Date(cleaned);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

async function dpdRequest<T>(path: string): Promise<T> {
  const accountNumber = process.env.DPD_ACCOUNT_NUMBER;
  for (const attempt of [1, 2]) {
    const session = await getSession(attempt === 2);
    const headers: Record<string, string> = {
      "GEOSession": session,
      "Accept": "application/json",
    };
    if (accountNumber) headers["GEOClient"] = `account/${accountNumber}`;

    const res = await fetch(DPD_BASE + path, { headers, cache: "no-store" });
    if ((res.status === 401 || res.status === 403) && attempt === 1) continue;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DPD ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }
  throw new Error("Unreachable");
}

export async function trackDpd(consignment: string): Promise<DPDTrackingResult> {
  if (!consignment) {
    return { consignment, status: "not_found", deliveredAt: null, lastEvent: null };
  }
  try {
    // Per the official Perl DPD client + our diagnostic results, the correct
    // search endpoint is /shipping/shipment/?searchCriteria=<reference>
    const search = await dpdRequest<any>(
      `/shipping/shipment/?searchCriteria=${encodeURIComponent(consignment)}&searchPage=1&searchPageSize=10`
    );

    // Response shape varies; try multiple paths to find shipments
    const shipments: any[] =
      search?.data?.shipments ??
      search?.data?.Items ??
      search?.shipments ??
      (Array.isArray(search?.data) ? search.data : []) ??
      [];

    if (shipments.length === 0) {
      return { consignment, status: "not_found", deliveredAt: null, lastEvent: null };
    }
    const sh = shipments[0];
    const shipmentId = sh.shipmentId || sh.shipmentReference || sh.id;

    let events: any[] = [];
    if (shipmentId) {
      try {
        // Tracking detail. Try the documented path first.
        const history = await dpdRequest<any>(`/shipping/shipment/${shipmentId}/tracking/`);
        events = history?.data?.trackingEvent ?? history?.data?.events ?? history?.trackingEvent ?? [];
      } catch {
        // Some versions don't expose this — fall back to search-level info
      }
    }

    let deliveredAt: string | null = null;
    let lastEvent: string | null = null;
    for (const ev of events) {
      const desc = (ev.trackingEventStatus || ev.trackingEventDescription || ev.status || "").toLowerCase();
      if (!desc) continue;
      lastEvent = ev.trackingEventStatus || ev.trackingEventDescription || ev.status || lastEvent;
      if (DELIVERED_KEYWORDS.some(kw => desc.includes(kw))) {
        const dt = parseDpdDateTime(ev.trackingEventDateTime || ev.trackingEventDate || ev.dateTime);
        if (dt) deliveredAt = dt;
      }
    }
    // Fallback: top-level deliveredDateTime
    if (!deliveredAt) {
      const dt = parseDpdDateTime(
        sh?.deliveryDetails?.notificationDetails?.deliveredDateTime ??
        sh?.deliveredDateTime ??
        sh?.deliveryDate
      );
      if (dt) deliveredAt = dt;
    }

    const trackingStatus: string = (sh.trackingStatus || sh.status || "").toLowerCase();
    let status: DPDTrackingStatus;
    if (deliveredAt) status = "delivered";
    else if (trackingStatus.includes("exception") || trackingStatus.includes("problem")) status = "exception";
    else if (trackingStatus) status = "in_transit";
    else status = "pending";

    return { consignment, status, deliveredAt, lastEvent: lastEvent ?? sh.trackingStatus ?? null };
  } catch (e: any) {
    console.warn(`DPD tracking failed for ${consignment}:`, e?.message);
    return { consignment, status: "not_found", deliveredAt: null, lastEvent: String(e?.message ?? e).slice(0, 200) };
  }
}
