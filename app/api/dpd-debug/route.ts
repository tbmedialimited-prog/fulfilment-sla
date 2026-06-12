// DPD v24 - debugging which credentials Vercel is actually using.
// Shows env var fingerprints (without revealing secrets) so we know
// whether the right values are in place.

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const BASE = "https://api.customers.dpd.co.uk";

function fingerprint(s: string | undefined): string {
  if (!s) return "EMPTY";
  if (s.length < 4) return `(${s.length} chars)`;
  return `${s.slice(0, 4)}...${s.slice(-2)} (${s.length} chars)`;
}

function detectUserType(u: string): string {
  if (!u) return "missing";
  if (u.includes("@")) return "email (looks like dev portal login)";
  if (/^[a-z]+\d+$/i.test(u)) return "legacy shipping username (e.g. thefulfilment2)";
  return "unknown format";
}

async function tryLogin(label: string, headers: Record<string, string>, body: string | null = null) {
  try {
    const res = await fetch(`${BASE}/v1/customer/auth/access`, {
      method: "POST",
      headers,
      body: body ?? undefined,
      cache: "no-store",
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch {}
    const tok = parsed?.data?.accessToken ?? parsed?.accessToken ?? parsed?.access_token ?? parsed?.token ?? null;
    return {
      label,
      status: res.status,
      got_token: !!tok,
      preview: parsed ? JSON.stringify(parsed).slice(0, 400) : text.slice(0, 400),
    };
  } catch (e: any) {
    return { label, status: 0, error: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function GET(req: NextRequest) {
  const username = process.env.DPD_USERNAME || "";
  const password = process.env.DPD_PASSWORD || "";
  const apiKey = process.env.DPD_API_KEY || "";

  const out: any = {
    env_check: {
      DPD_USERNAME: {
        fingerprint: fingerprint(username),
        type: detectUserType(username),
        is_email: username.includes("@"),
      },
      DPD_PASSWORD: {
        fingerprint: fingerprint(password),
      },
      DPD_API_KEY: {
        fingerprint: fingerprint(apiKey),
        looks_correct: apiKey.startsWith("LSIb2"),
      },
    },
    login_attempts: [] as any[],
  };

  if (!username || !password) {
    out.error = "DPD_USERNAME or DPD_PASSWORD env vars are empty";
    return NextResponse.json(out);
  }

  const creds = Buffer.from(`${username}:${password}`).toString("base64");

  // Standard Basic auth + client-id
  out.login_attempts.push(await tryLogin(
    "Basic auth + client-id header",
    {
      "Authorization": `Basic ${creds}`,
      "client-id": apiKey,
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
  ));

  // Maybe the API expects email in body instead
  out.login_attempts.push(await tryLogin(
    "client-id only, email/password in body",
    {
      "client-id": apiKey,
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
    JSON.stringify({ email: username, password }),
  ));

  // OAuth-style grant
  out.login_attempts.push(await tryLogin(
    "Bearer apiKey + email/password in body",
    {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
    JSON.stringify({ email: username, password }),
  ));

  // What if creds need to be in the body alongside grant_type
  out.login_attempts.push(await tryLogin(
    "client-id + grant_type=password in body",
    {
      "client-id": apiKey,
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
    JSON.stringify({ grant_type: "password", username, password }),
  ));

  // form-encoded
  try {
    const formBody = new URLSearchParams({ username, password, grant_type: "password", client_id: apiKey });
    const res = await fetch(`${BASE}/v1/customer/auth/access`, {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
      cache: "no-store",
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch {}
    out.login_attempts.push({
      label: "form-encoded oauth grant",
      status: res.status,
      preview: parsed ? JSON.stringify(parsed).slice(0, 400) : text.slice(0, 400),
    });
  } catch (e: any) {
    out.login_attempts.push({ label: "form-encoded oauth grant", error: String(e?.message ?? e) });
  }

  return NextResponse.json(out);
}
