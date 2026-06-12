// DPD v21 - try email address as client-id (user's developer portal login)
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
    return d?.data?.geoSession || null;
  } catch { return null; }
}

async function tryTrack(authValue: string, clientIdValue: string, label: string) {
  try {
    const res = await fetch(`${TRACK_BASE}/v1/customer/parcel/tracking`, {
      method: "POST",
      headers: {
        "Authorization": authValue,
        "client-id": clientIdValue,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ parcelNumbers: ["15976913071805"] }),
      cache: "no-store",
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch {}
    return { label, client_id: clientIdValue, status: res.status, preview: parsed ? JSON.stringify(parsed).slice(0, 500) : text.slice(0, 200) };
  } catch (e: any) {
    return { label, status: 0, error: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function GET(req: NextRequest) {
  const out: any = { attempts: [] as any[] };
  const session = await login();
  if (!session) { out.error = "login failed"; return NextResponse.json(out); }

  const candidates = [
    "tadeas.gencur@fulfilmentexperts.co.uk",
    "tadeas.gencur",
    "thefulfilment2",
    "info@fulfilmentexperts.co.uk",
    "feri.urban@tbmediagroup.co.uk",
    "fulfilmentexperts",
    "fulfilment-experts",
    "TheFulfilmentExperts",
    "fulfilmentexperts.co.uk",
    "thefulfilment",
    "Fulfilment Experts",
    "FULFILMENT EXPERTS",
  ];

  for (const c of candidates) {
    out.attempts.push(await tryTrack(`Bearer ${session}`, c, c));
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
