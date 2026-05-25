// DPD API diagnostic. Tries login and multiple candidate tracking endpoints
// to discover what works against your account.
//
// Usage: /api/dpd-debug?tracking=15976913071805

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const DPD_BASE = process.env.DPD_BASE_URL || "https://api.dpd.co.uk";

interface DpdLoginResponse {
  data?: { geoSession?: string };
  geoSession?: string;
  error?: any;
}

async function login(): Promise<{ ok: boolean; session?: string; raw?: any; status: number; error?: string }> {
  const username = process.env.DPD_USERNAME;
  const password = process.env.DPD_PASSWORD;
  const accountNumber = process.env.DPD_ACCOUNT_NUMBER;
  if (!username || !password) return { ok: false, status: 0, error: "DPD_USERNAME / DPD_PASSWORD not set" };

  const creds = Buffer.from(`${username}:${password}`).toString("base64");
  const headers: Record<string, string> = {
    "Authorization": `Basic ${creds}`,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
  if (accountNumber) headers["GEOClient"] = `account/${accountNumber}`;

  try {
    const res = await fetch(`${DPD_BASE}/user/?action=login`, { method: "POST", headers, cache: "no-store" });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* keep raw text */ }
    const session = data?.data?.geoSession || data?.geoSession;
    if (!res.ok || !session) {
      return { ok: false, status: res.status, raw: data ?? text.slice(0, 500), error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, session, raw: { gotSession: true } };
  } catch (e: any) {
    return { ok: false, status: 0, error: String(e?.message ?? e) };
  }
}

async function tryEndpoint(path: string, session: string): Promise<any> {
  const accountNumber = process.env.DPD_ACCOUNT_NUMBER;
  const headers: Record<string, string> = {
    "GEOSession": session,
    "Accept": "application/json",
  };
  if (accountNumber) headers["GEOClient"] = `account/${accountNumber}`;

  try {
    const res = await fetch(DPD_BASE + path, { headers, cache: "no-store" });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* */ }
    return {
      path,
      status: res.status,
      ok: res.ok,
      body_preview: data ? JSON.stringify(data).slice(0, 800) : text.slice(0, 800),
    };
  } catch (e: any) {
    return { path, status: 0, error: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function GET(req: NextRequest) {
  const tracking = req.nextUrl.searchParams.get("tracking") || "15976913071805";
  const out: any = { base: DPD_BASE, tracking };

  // Step 1: login
  const auth = await login();
  out.login = { ok: auth.ok, status: auth.status, error: auth.error, raw: auth.raw };
  if (!auth.ok || !auth.session) return NextResponse.json(out);

  // Step 2: try various endpoints we think might work
  const candidates = [
    `/shipping/shipment/?searchCriteria=${tracking}`,
    `/shipping/shipment/?searchPage=1&searchPageSize=10&searchType=trackingReferences&searchKeyword=${tracking}`,
    `/shipping/shipment/_search?searchPage=1&searchPageSize=10&searchType=trackingReferences&searchKeyword=${tracking}`,
    `/shipping/tracking/?parcel=${tracking}`,
    `/shipping/tracking/${tracking}`,
    `/parcels/${tracking}`,
    `/tracking/${tracking}`,
    `/tracking/?parcel=${tracking}`,
    `/parcel/?trackingNumber=${tracking}`,
    `/v1/tracking/${tracking}`,
  ];

  out.attempts = [];
  for (const path of candidates) {
    const r = await tryEndpoint(path, auth.session);
    out.attempts.push(r);
    // Small delay so we don't hammer
    await new Promise(rs => setTimeout(rs, 200));
  }

  return NextResponse.json(out);
}
