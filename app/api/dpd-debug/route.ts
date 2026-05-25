// DPD diagnostic v5 - probes the PUBLIC tracking API at apis.track.dpdlocal.co.uk
// Based on Pen Test Partners finding: the public tracker uses /v1/* endpoints there.
// The auth pattern: GET /parcels/<code>?postcode=<pc> grants a session, then JSON endpoints work.

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

async function tryUrl(url: string, headers: Record<string, string> = {}, method = "GET") {
  try {
    const res = await fetch(url, { method, headers, cache: "no-store", redirect: "manual" });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* */ }
    // Collect set-cookie headers (might be auth tokens)
    const cookies = res.headers.get("set-cookie") || "";
    return {
      url,
      method,
      status: res.status,
      contentType: res.headers.get("content-type") || "",
      bodyLength: text.length,
      cookies: cookies.slice(0, 300),
      preview: parsed ? JSON.stringify(parsed).slice(0, 500) : text.slice(0, 500),
    };
  } catch (e: any) {
    return { url, method, status: 0, error: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function GET(req: NextRequest) {
  const tracking = req.nextUrl.searchParams.get("tracking") || "15976912925627";
  const postcode = req.nextUrl.searchParams.get("postcode") || "GL103WB";
  const out: any = { tracking, postcode, attempts: [] as any[] };

  // ===== Try the PUBLIC tracking API base URLs =====
  // Based on Pen Test Partners discovery: apis.track.dpdlocal.co.uk/v1/...

  const publicBases = [
    "https://apis.track.dpdlocal.co.uk",
    "https://apis.track.dpd.co.uk",
    "https://api.track.dpdlocal.co.uk",
    "https://api.track.dpd.co.uk",
    "https://track.dpdlocal.co.uk",
  ];

  const pathPatterns = [
    `/v1/parcels/${tracking}`,
    `/v1/parcels/${tracking}?postcode=${postcode}`,
    `/v1/parcels/${tracking}/route`,
    `/v1/parcels/${tracking}/events`,
    `/v1/parcels/${tracking}/tracking`,
    `/parcels/${tracking}`,
    `/parcels/${tracking}?postcode=${postcode}`,
    `/v1/tracking/${tracking}`,
    `/v1/tracking/${tracking}?postcode=${postcode}`,
    `/v1/map/route?parcelCode=${tracking}`,
  ];

  const headers = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; SLA-Dashboard)",
  };

  for (const base of publicBases) {
    for (const path of pathPatterns) {
      out.attempts.push(await tryUrl(base + path, headers));
      await new Promise(r => setTimeout(r, 50));
    }
  }

  // ===== Filter to interesting results =====
  // Anything that's not 0, not 404, AND has either JSON content or a body
  out.interesting = out.attempts.filter((a: any) =>
    a.status !== 0 &&
    a.status !== 404 &&
    a.bodyLength > 20
  );
  out.total_attempts = out.attempts.length;
  out.found = out.interesting.length;
  return NextResponse.json(out);
}
