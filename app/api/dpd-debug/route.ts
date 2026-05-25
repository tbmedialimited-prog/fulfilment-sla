// DPD diagnostic v3 - now that we know the right flow:
// 1. POST /user/?action=login with Basic auth -> get geoSession
// 2. GET /shipping/shipment/?searchCriteria=<tracking> with GEOSession header
// 3. GET /shipping/shipment/<id>/tracking/ with GEOSession header
//
// Usage: /api/dpd-debug?tracking=15976913071805

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const DPD_BASE = process.env.DPD_BASE_URL || "https://api.dpdlocal.co.uk";

export async function GET(req: NextRequest) {
  const tracking = req.nextUrl.searchParams.get("tracking") || "15976913071805";
  const username = process.env.DPD_USERNAME || "";
  const password = process.env.DPD_PASSWORD || "";
  const accountNumber = process.env.DPD_ACCOUNT_NUMBER || "";

  const out: any = { tracking, base: DPD_BASE };

  // Step 1: Login
  const creds = Buffer.from(`${username}:${password}`).toString("base64");
  const loginHeaders: Record<string, string> = {
    "Authorization": `Basic ${creds}`,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
  if (accountNumber) loginHeaders["GEOClient"] = `account/${accountNumber}`;

  let session: string | null = null;
  try {
    const loginRes = await fetch(`${DPD_BASE}/user/?action=login`, {
      method: "POST",
      headers: loginHeaders,
      cache: "no-store",
    });
    const loginData = await loginRes.json();
    session = loginData?.data?.geoSession || loginData?.geoSession;
    out.step1_login = {
      status: loginRes.status,
      ok: loginRes.ok,
      got_session: !!session,
    };
    if (!session) {
      out.step1_login.raw_body = JSON.stringify(loginData).slice(0, 500);
      return NextResponse.json(out);
    }
  } catch (e: any) {
    out.step1_login = { error: String(e?.message ?? e) };
    return NextResponse.json(out);
  }

  // Step 2: Search shipment by tracking reference
  const authHeaders: Record<string, string> = {
    "GEOSession": session,
    "Accept": "application/json",
  };
  if (accountNumber) authHeaders["GEOClient"] = `account/${accountNumber}`;

  // Try multiple search query patterns
  const searchPaths = [
    `/shipping/shipment/?searchCriteria=${encodeURIComponent(tracking)}`,
    `/shipping/shipment/?searchCriteria=${encodeURIComponent(tracking)}&searchPage=1&searchPageSize=10`,
    `/shipping/shipment?searchCriteria=${encodeURIComponent(tracking)}`,
  ];
  out.step2_search = [];
  let shipmentId: string | number | null = null;
  let shipment: any = null;
  for (const path of searchPaths) {
    try {
      const res = await fetch(DPD_BASE + path, { headers: authHeaders, cache: "no-store" });
      const text = await res.text();
      let data: any = null;
      try { data = JSON.parse(text); } catch { /* */ }
      const attempt: any = {
        path,
        status: res.status,
        ok: res.ok,
        body_keys: data && typeof data === "object" ? Object.keys(data).slice(0, 10) : null,
        body_preview: text.slice(0, 800),
      };
      // Try to find shipment ID in the response
      const ships =
        data?.data?.shipments ??
        data?.data?.Items ??
        data?.shipments ??
        (Array.isArray(data?.data) ? data.data : null);
      if (ships && ships.length > 0) {
        attempt.found_count = ships.length;
        attempt.first_ship_keys = Object.keys(ships[0]).slice(0, 20);
        shipmentId = ships[0].shipmentId || ships[0].shipmentReference || ships[0].id;
        shipment = ships[0];
        attempt.shipment_id = shipmentId;
      }
      out.step2_search.push(attempt);
      if (shipmentId) break;
    } catch (e: any) {
      out.step2_search.push({ path, error: String(e?.message ?? e) });
    }
  }

  // Step 3: Get tracking events for shipment (if found)
  if (shipmentId) {
    const trackPaths = [
      `/shipping/shipment/${shipmentId}/tracking/`,
      `/shipping/shipment/${shipmentId}/tracking`,
      `/shipping/shipment/${shipmentId}/`,
      `/shipping/shipment/${shipmentId}`,
    ];
    out.step3_tracking = [];
    for (const path of trackPaths) {
      try {
        const res = await fetch(DPD_BASE + path, { headers: authHeaders, cache: "no-store" });
        const text = await res.text();
        let data: any = null;
        try { data = JSON.parse(text); } catch { /* */ }
        out.step3_tracking.push({
          path,
          status: res.status,
          ok: res.ok,
          body_keys: data && typeof data === "object" ? Object.keys(data).slice(0, 10) : null,
          data_keys: data?.data && typeof data.data === "object" ? Object.keys(data.data).slice(0, 20) : null,
          body_preview: text.slice(0, 1200),
        });
      } catch (e: any) {
        out.step3_tracking.push({ path, error: String(e?.message ?? e) });
      }
    }
  } else {
    out.step3_tracking = "skipped - no shipment ID found";
  }

  // Include sample shipment object for reference
  if (shipment) {
    out.sample_shipment = JSON.stringify(shipment).slice(0, 1500);
  }

  return NextResponse.json(out);
}
