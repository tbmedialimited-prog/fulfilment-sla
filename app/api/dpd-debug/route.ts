// DPD diagnostic v9 - uses the OFFICIAL endpoint confirmed by Andy at DPD:
// POST https://api.customers.dpd.co.uk/v1/customer/parcel/tracking
//
// Tries all 4 search parameter combinations to find what returns data for your parcels.

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const LOGIN_BASE = "https://api.dpdlocal.co.uk";
const TRACK_BASE = "https://api.customers.dpd.co.uk";

async function login(): Promise<{ session: string | null; status: number; raw?: any }> {
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
    return { session: d?.data?.geoSession || d?.geoSession || null, status: res.status, raw: d };
  } catch (e: any) {
    return { session: null, status: 0, raw: { error: String(e?.message ?? e) } };
  }
}

async function trackAttempt(session: string, body: any, label: string) {
  const account = process.env.DPD_ACCOUNT_NUMBER || "";
  const headers: Record<string, string> = {
    "GEOSession": session,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
  if (account) headers["GEOClient"] = `account/${account}`;

  // Try POST first (most common for "tracking" lookup with body)
  try {
    const postRes = await fetch(`${TRACK_BASE}/v1/customer/parcel/tracking`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const text = await postRes.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch {}
    return {
      label,
      method: "POST",
      body,
      status: postRes.status,
      bodyLength: text.length,
      preview: parsed ? JSON.stringify(parsed).slice(0, 1500) : text.slice(0, 600),
    };
  } catch (e: any) {
    return { label, method: "POST", body, status: 0, error: String(e?.message ?? e).slice(0, 200) };
  }
}

async function trackAttemptGet(session: string, queryString: string, label: string) {
  const account = process.env.DPD_ACCOUNT_NUMBER || "";
  const headers: Record<string, string> = {
    "GEOSession": session,
    "Accept": "application/json",
  };
  if (account) headers["GEOClient"] = `account/${account}`;

  try {
    const res = await fetch(`${TRACK_BASE}/v1/customer/parcel/tracking?${queryString}`, {
      method: "GET",
      headers,
      cache: "no-store",
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch {}
    return {
      label,
      method: "GET",
      queryString,
      status: res.status,
      bodyLength: text.length,
      preview: parsed ? JSON.stringify(parsed).slice(0, 1500) : text.slice(0, 600),
    };
  } catch (e: any) {
    return { label, method: "GET", queryString, status: 0, error: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function GET(req: NextRequest) {
  const tracking = req.nextUrl.searchParams.get("tracking") || "15976913071805";
  const postcode = req.nextUrl.searchParams.get("postcode") || "GL103WB";
  const orderRef = req.nextUrl.searchParams.get("ref") || "638686901";

  const out: any = { tracking, postcode, orderRef, attempts: [] as any[] };

  const auth = await login();
  out.login = { status: auth.status, got_session: !!auth.session };
  if (!auth.session) {
    out.login.raw = auth.raw;
    return NextResponse.json(out);
  }

  // Try all 4 documented search parameter combinations
  out.attempts.push(await trackAttempt(auth.session, { parcelNumbers: [tracking] }, "POST parcelNumbers"));
  await new Promise(r => setTimeout(r, 200));
  out.attempts.push(await trackAttempt(auth.session, { customerReference: orderRef, postcode }, "POST customerReference+postcode"));
  await new Promise(r => setTimeout(r, 200));
  out.attempts.push(await trackAttempt(auth.session, { customerReference: orderRef }, "POST customerReference"));
  await new Promise(r => setTimeout(r, 200));
  out.attempts.push(await trackAttempt(auth.session, { searchKey: tracking }, "POST searchKey"));
  await new Promise(r => setTimeout(r, 200));

  // Also try GET with query string variants (in case the API is GET-based)
  out.attempts.push(await trackAttemptGet(auth.session, `parcelNumber=${tracking}`, "GET parcelNumber"));
  await new Promise(r => setTimeout(r, 200));
  out.attempts.push(await trackAttemptGet(auth.session, `parcelNumbers=${tracking}`, "GET parcelNumbers"));
  await new Promise(r => setTimeout(r, 200));
  out.attempts.push(await trackAttemptGet(auth.session, `customerReference=${orderRef}&postcode=${postcode}`, "GET customerReference+postcode"));
  await new Promise(r => setTimeout(r, 200));

  out.successes = out.attempts.filter((a: any) => a.status === 200 && a.bodyLength > 50);
  return NextResponse.json(out);
}
