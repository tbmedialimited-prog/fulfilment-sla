// DPD API diagnostic v2 - tries BOTH auth methods (Basic-then-Session AND Bearer)
// against several base URLs and endpoint paths.
//
// Usage: /api/dpd-debug?tracking=15976913071805

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

async function tryUrl(url: string, headers: Record<string, string>, method = "GET", body?: string) {
  try {
    const res = await fetch(url, { method, headers, body, cache: "no-store" });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* */ }
    return {
      url,
      method,
      status: res.status,
      ok: res.ok,
      body_preview: data ? JSON.stringify(data).slice(0, 600) : text.slice(0, 600),
    };
  } catch (e: any) {
    return { url, method, status: 0, error: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function GET(req: NextRequest) {
  const tracking = req.nextUrl.searchParams.get("tracking") || "15976913071805";
  const apiKey = process.env.DPD_API_KEY || "";
  const username = process.env.DPD_USERNAME || "";
  const password = process.env.DPD_PASSWORD || "";
  const accountNumber = process.env.DPD_ACCOUNT_NUMBER || "";

  const out: any = {
    tracking,
    env: {
      has_api_key: !!apiKey,
      has_username: !!username,
      has_password: !!password,
      has_account: !!accountNumber,
    },
    tests: [] as any[],
  };

  // Test 1: Bearer auth against api.dpd.co.uk
  if (apiKey) {
    const bearerHeaders = {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json",
    };
    const bases = [
      "https://api.dpd.co.uk",
      "https://api.dpdlocal.co.uk",
      "https://developers.api.dpd.co.uk",
    ];
    const paths = [
      `/shipping/shipment/?searchCriteria=${tracking}`,
      `/shipping/tracking/${tracking}`,
      `/tracking/${tracking}`,
      `/v1/tracking/${tracking}`,
      `/parcels/${tracking}`,
    ];
    for (const base of bases) {
      for (const path of paths) {
        out.tests.push({ kind: "bearer", ...(await tryUrl(base + path, bearerHeaders)) });
        await new Promise(r => setTimeout(r, 100));
      }
    }
  }

  // Test 2: X-API-Key header (another common pattern)
  if (apiKey) {
    const headers = { "X-API-Key": apiKey, "Accept": "application/json" };
    const urls = [
      `https://api.dpd.co.uk/tracking/${tracking}`,
      `https://api.dpdlocal.co.uk/tracking/${tracking}`,
    ];
    for (const url of urls) {
      out.tests.push({ kind: "x-api-key", ...(await tryUrl(url, headers)) });
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // Test 3: Legacy Basic/Session auth at api.dpd.co.uk
  if (username && password) {
    const creds = Buffer.from(`${username}:${password}`).toString("base64");
    const headers: Record<string, string> = {
      "Authorization": `Basic ${creds}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
    };
    if (accountNumber) headers["GEOClient"] = `account/${accountNumber}`;
    out.tests.push({
      kind: "basic-login-dpd",
      ...(await tryUrl("https://api.dpd.co.uk/user/?action=login", headers, "POST")),
    });
    await new Promise(r => setTimeout(r, 100));
    out.tests.push({
      kind: "basic-login-dpdlocal",
      ...(await tryUrl("https://api.dpdlocal.co.uk/user/?action=login", headers, "POST")),
    });
  }

  return NextResponse.json(out);
}
