// DPD v13 - now we know:
//   - The user has MULTIPLE DPD account numbers per client (3023118, 3025796, 3026126, 3029187, 3029553)
//   - "client-id" may be one of those, OR a UUID from the JWT
// Tries all of them.

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const LOGIN_BASE = "https://api.dpdlocal.co.uk";
const TRACK_BASE = "https://api.customers.dpd.co.uk";

function decodeJwtPayload(jwt: string): any {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], "base64").toString("utf-8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

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
    return { session: d?.data?.geoSession || null, raw: d };
  } catch (e: any) {
    return { session: null, error: String(e?.message ?? e) };
  }
}

async function tryTrack(authValue: string, clientIdValue: string, label: string) {
  const headers: Record<string, string> = {
    "Authorization": authValue,
    "client-id": clientIdValue,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
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
      client_id: clientIdValue,
      status: res.status,
      preview: parsed ? JSON.stringify(parsed).slice(0, 400) : text.slice(0, 200),
    };
  } catch (e: any) {
    return { label, client_id: clientIdValue, status: 0, error: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function GET(req: NextRequest) {
  const out: any = { attempts: [] as any[] };

  const auth = await login();
  if (!auth.session) { out.error = "login failed"; return NextResponse.json(out); }

  const payload = decodeJwtPayload(auth.session);
  out.jwt_payload = payload;

  // Candidate client-id values to try
  const candidates: { label: string; value: string }[] = [];
  if (payload) {
    if (payload.publicKey) candidates.push({ label: "JWT.publicKey", value: payload.publicKey });
    if (payload.auth_key) candidates.push({ label: "JWT.auth_key", value: payload.auth_key });
    if (payload.user_id) candidates.push({ label: "JWT.user_id", value: payload.user_id });
    if (payload.dpd_account) candidates.push({ label: "JWT.dpd_account", value: payload.dpd_account });
  }

  // All client account numbers we know about
  const accountNumbers = ["3025796", "3023118", "3026126", "3029553", "3029187"];
  for (const a of accountNumbers) candidates.push({ label: `account ${a}`, value: a });

  // Also the API key from portal
  const apiKey = process.env.DPD_API_KEY;
  if (apiKey) candidates.push({ label: "DPD_API_KEY", value: apiKey });

  for (const c of candidates) {
    out.attempts.push(await tryTrack(`Bearer ${auth.session}`, c.value, c.label));
    await new Promise(r => setTimeout(r, 150));
    const last = out.attempts[out.attempts.length - 1];
    if (last.status === 200) {
      out.SUCCESS = last;
      break;
    }
  }

  out.successes = out.attempts.filter((a: any) => a.status === 200);
  return NextResponse.json(out);
}
