// DPD diagnostic v10 - same auth + endpoint, but now adding the client-id header
// in various forms to find what DPD expects.

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

async function tryTrack(session: string, body: any, clientIdValue: string, clientIdHeader: string) {
  const headers: Record<string, string> = {
    "GEOSession": session,
    "Accept": "application/json",
    "Content-Type": "application/json",
    [clientIdHeader]: clientIdValue,
  };

  try {
    const res = await fetch(`${TRACK_BASE}/v1/customer/parcel/tracking`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch {}
    return {
      headerName: clientIdHeader,
      headerValue: clientIdValue,
      body,
      status: res.status,
      bodyLength: text.length,
      preview: parsed ? JSON.stringify(parsed).slice(0, 1200) : text.slice(0, 500),
    };
  } catch (e: any) {
    return { headerName: clientIdHeader, headerValue: clientIdValue, body, status: 0, error: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function GET(req: NextRequest) {
  const tracking = req.nextUrl.searchParams.get("tracking") || "15976913071805";
  const account = process.env.DPD_ACCOUNT_NUMBER || "3025796";

  const out: any = { tracking, account, attempts: [] as any[] };

  const auth = await login();
  out.login = { status: auth.status, got_session: !!auth.session };
  if (!auth.session) {
    return NextResponse.json(out);
  }

  // Header name variations to try (DPD inconsistently spells)
  const headerNames = ["client-id", "clientId", "Client-Id", "ClientId", "X-Client-Id", "x-client-id"];

  // Value variations to try
  const headerValues = [
    account,                    // just "3025796"
    `account/${account}`,       // "account/3025796"
    `client/${account}`,        // "client/3025796"
  ];

  const body = { parcelNumbers: [tracking] };

  // Try each header name with each value variant
  for (const hName of headerNames) {
    for (const hValue of headerValues) {
      out.attempts.push(await tryTrack(auth.session, body, hValue, hName));
      await new Promise(r => setTimeout(r, 150));
      // Early exit if one works
      const last = out.attempts[out.attempts.length - 1];
      if (last.status === 200 && last.bodyLength > 50) {
        out.success_found = last;
        break;
      }
    }
    if (out.success_found) break;
  }

  out.successes = out.attempts.filter((a: any) => a.status === 200 && a.bodyLength > 50);
  out.non_400_errors = out.attempts.filter((a: any) => a.status !== 400 && a.status !== 200);
  return NextResponse.json(out);
}
