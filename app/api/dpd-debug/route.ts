// DPD diagnostic v11 - we know:
//   Header "client-id" works (lowercase, hyphen)
//   Now the API wants "authorization" header
// Test what kind of auth value works.

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const LOGIN_BASE = "https://api.dpdlocal.co.uk";
const TRACK_BASE = "https://api.customers.dpd.co.uk";

async function login() {
  const username = process.env.DPD_USERNAME || "";
  const password = process.env.DPD_PASSWORD || "";
  const account = process.env.DPD_ACCOUNT_NUMBER || "";
  const creds = Buffer.from(`${username}:${password}`).toString("base64");
  const headers: Record<string, string> = {
    "Authorization": `Basic ${creds}`,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
  if (account) headers["GEOClient"] = `account/${account}`;
  try {
    const res = await fetch(`${LOGIN_BASE}/user/?action=login`, { method: "POST", headers, cache: "no-store" });
    const d = await res.json();
    return { session: d?.data?.geoSession || null, status: res.status };
  } catch (e: any) {
    return { session: null, status: 0, error: String(e?.message ?? e) };
  }
}

async function tryTrack(authHeader: string, label: string, alsoSetGeoSession = false, session?: string) {
  const account = process.env.DPD_ACCOUNT_NUMBER || "3025796";
  const headers: Record<string, string> = {
    "Authorization": authHeader,
    "client-id": account,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
  if (alsoSetGeoSession && session) headers["GEOSession"] = session;

  try {
    const res = await fetch(`${TRACK_BASE}/v1/customer/parcel/tracking`, {
      method: "POST",
      headers,
      body: JSON.stringify({ parcelNumbers: ["15976913071805"] }),
      cache: "no-store",
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch {}
    return {
      label,
      authHeader: authHeader.length > 30 ? authHeader.slice(0, 30) + "..." : authHeader,
      status: res.status,
      bodyLength: text.length,
      preview: parsed ? JSON.stringify(parsed).slice(0, 1500) : text.slice(0, 600),
    };
  } catch (e: any) {
    return { label, authHeader, status: 0, error: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function GET(req: NextRequest) {
  const apiKey = process.env.DPD_API_KEY || "";
  const username = process.env.DPD_USERNAME || "";
  const password = process.env.DPD_PASSWORD || "";

  const out: any = { attempts: [] as any[], env: { has_api_key: !!apiKey, has_username: !!username } };

  // Get geoSession for some tests
  const auth = await login();
  out.login = { status: auth.status, got_session: !!auth.session };

  // Try various Authorization header values
  if (apiKey) {
    out.attempts.push(await tryTrack(`Bearer ${apiKey}`, "Bearer <apiKey>"));
    await new Promise(r => setTimeout(r, 150));
    out.attempts.push(await tryTrack(apiKey, "Raw <apiKey>"));
    await new Promise(r => setTimeout(r, 150));
    out.attempts.push(await tryTrack(`Token ${apiKey}`, "Token <apiKey>"));
    await new Promise(r => setTimeout(r, 150));
  }
  if (auth.session) {
    out.attempts.push(await tryTrack(`Bearer ${auth.session}`, "Bearer <geoSession>"));
    await new Promise(r => setTimeout(r, 150));
    out.attempts.push(await tryTrack(auth.session, "Raw <geoSession>"));
    await new Promise(r => setTimeout(r, 150));
  }
  if (username && password) {
    const creds = Buffer.from(`${username}:${password}`).toString("base64");
    out.attempts.push(await tryTrack(`Basic ${creds}`, "Basic <user:pass>"));
    await new Promise(r => setTimeout(r, 150));
  }
  // Try Bearer geoSession AND GEOSession header together (maybe both are needed)
  if (auth.session) {
    out.attempts.push(await tryTrack(`Bearer ${auth.session}`, "Bearer + GEOSession header", true, auth.session));
    await new Promise(r => setTimeout(r, 150));
  }
  if (apiKey && auth.session) {
    out.attempts.push(await tryTrack(`Bearer ${apiKey}`, "Bearer apiKey + GEOSession header", true, auth.session));
  }

  out.successes = out.attempts.filter((a: any) => a.status === 200 && a.bodyLength > 50);
  return NextResponse.json(out);
}
