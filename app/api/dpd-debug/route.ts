// DPD v23 - using the CORRECT endpoints per Andy at DPD:
//   Login: POST https://api.customers.dpd.co.uk/v1/customer/auth/access
//   Track: POST https://api.customers.dpd.co.uk/v1/customer/parcel/tracking
//   client-id = the API key from the developer portal

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const BASE = "https://api.customers.dpd.co.uk";

async function doLogin() {
  const apiKey = process.env.DPD_API_KEY || "";
  const username = process.env.DPD_USERNAME || "";
  const password = process.env.DPD_PASSWORD || "";

  // Try a few auth formats since we don't know the exact body shape yet
  const variants: Array<{ label: string; method: string; headers: Record<string, string>; body: string | null }> = [
    {
      label: "Basic auth + client-id, no body",
      method: "POST",
      headers: {
        "Authorization": `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        "client-id": apiKey,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: null,
    },
    {
      label: "Basic auth + client-id, empty JSON body",
      method: "POST",
      headers: {
        "Authorization": `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        "client-id": apiKey,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: "{}",
    },
    {
      label: "JSON body with username+password, client-id header",
      method: "POST",
      headers: {
        "client-id": apiKey,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    },
    {
      label: "JSON body with email + apiKey, no client-id",
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password, apiKey }),
    },
  ];

  const results: any[] = [];
  let session: string | null = null;
  let workingVariant: any = null;

  for (const v of variants) {
    try {
      const res = await fetch(`${BASE}/v1/customer/auth/access`, {
        method: v.method,
        headers: v.headers,
        body: v.body || undefined,
        cache: "no-store",
      });
      const text = await res.text();
      let parsed: any = null;
      try { parsed = JSON.parse(text); } catch {}
      const tok =
        parsed?.data?.accessToken ??
        parsed?.accessToken ??
        parsed?.data?.geoSession ??
        parsed?.geoSession ??
        parsed?.access_token ??
        parsed?.token ??
        null;
      results.push({
        label: v.label,
        status: res.status,
        got_token: !!tok,
        preview: parsed ? JSON.stringify(parsed).slice(0, 500) : text.slice(0, 400),
      });
      if (tok && !session) {
        session = tok;
        workingVariant = v.label;
      }
    } catch (e: any) {
      results.push({ label: v.label, status: 0, error: String(e?.message ?? e).slice(0, 200) });
    }
    await new Promise(r => setTimeout(r, 150));
  }

  return { session, workingVariant, results };
}

async function tryTrack(authValue: string, clientId: string, parcelNumber: string) {
  try {
    const res = await fetch(`${BASE}/v1/customer/parcel/tracking`, {
      method: "POST",
      headers: {
        "Authorization": authValue,
        "client-id": clientId,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ parcelNumbers: [parcelNumber] }),
      cache: "no-store",
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch {}
    return {
      status: res.status,
      bodyLength: text.length,
      preview: parsed ? JSON.stringify(parsed, null, 2).slice(0, 3000) : text.slice(0, 800),
    };
  } catch (e: any) {
    return { status: 0, error: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function GET(req: NextRequest) {
  const tracking = req.nextUrl.searchParams.get("tracking") || "15976913071805";
  const apiKey = process.env.DPD_API_KEY || "";

  const out: any = { tracking };

  // Step 1: Login at the NEW endpoint
  const auth = await doLogin();
  out.login_attempts = auth.results;
  out.login_working_variant = auth.workingVariant;
  out.got_session = !!auth.session;

  if (!auth.session) {
    return NextResponse.json(out);
  }

  // Step 2: Track with the access token + client-id header
  out.track_bearer = await tryTrack(`Bearer ${auth.session}`, apiKey, tracking);
  await new Promise(r => setTimeout(r, 200));
  out.track_raw = await tryTrack(auth.session, apiKey, tracking);

  return NextResponse.json(out);
}
