// DPD diagnostic v6 - now we know the parcelCode pattern: /^\d+\*\d{5}$/
// Test all plausible suffix combinations.

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const BASE = "https://apis.track.dpdlocal.co.uk";

async function tryUrl(url: string, headers: Record<string, string> = {}) {
  try {
    const res = await fetch(url, { headers, cache: "no-store", redirect: "manual" });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* */ }
    return {
      url: url.replace(BASE, ""),
      status: res.status,
      bodyLength: text.length,
      preview: parsed ? JSON.stringify(parsed).slice(0, 800) : text.slice(0, 400),
    };
  } catch (e: any) {
    return { url, status: 0, error: String(e?.message ?? e).slice(0, 200) };
  }
}

// Extract 5-digit suffixes from a postcode string in various ways
function postcodeSuffixes(pc: string): string[] {
  const clean = pc.replace(/\s/g, "").toUpperCase();
  const digits = clean.replace(/\D/g, "");
  const out = new Set<string>();
  // Last 5 chars of postcode
  if (clean.length >= 5) out.add(clean.slice(-5));
  // First 5 chars
  if (clean.length >= 5) out.add(clean.slice(0, 5));
  // Digits only, padded
  if (digits.length > 0) {
    out.add(digits.padStart(5, "0"));
    out.add(digits.padEnd(5, "0"));
    // First 5 digits or pad
    if (digits.length >= 5) out.add(digits.slice(0, 5));
  }
  return Array.from(out);
}

export async function GET(req: NextRequest) {
  const tracking = req.nextUrl.searchParams.get("tracking") || "15976912925627";
  const postcode = req.nextUrl.searchParams.get("postcode") || "GL103WB";
  const out: any = { tracking, postcode, attempts: [] as any[] };

  // Build candidate suffixes
  const suffixes = postcodeSuffixes(postcode);
  // Also try literal numeric variations
  const candidateSuffixes = [...suffixes, "00000", "12345"];

  // Try patterns
  for (const suffix of candidateSuffixes) {
    const parcelCode = `${tracking}*${suffix}`;
    // Several candidate paths
    const paths = [
      `/v1/parcels/${encodeURIComponent(parcelCode)}`,
      `/v1/parcels/${encodeURIComponent(parcelCode)}/events`,
      `/v1/parcels/${encodeURIComponent(parcelCode)}/tracking`,
    ];
    for (const path of paths) {
      out.attempts.push({ suffix, ...(await tryUrl(BASE + path)) });
      await new Promise(r => setTimeout(r, 80));
    }
  }

  // Also try truncating the tracking number to last 14 digits or other lengths
  for (const truncLen of [13, 12, 11, 14]) {
    if (tracking.length === truncLen) continue;
    const trunc = tracking.slice(-truncLen);
    for (const suffix of suffixes.slice(0, 2)) {
      const parcelCode = `${trunc}*${suffix}`;
      out.attempts.push({
        trunc, suffix,
        ...(await tryUrl(`${BASE}/v1/parcels/${encodeURIComponent(parcelCode)}`))
      });
      await new Promise(r => setTimeout(r, 80));
    }
  }

  // Filter to interesting
  out.successes = out.attempts.filter((a: any) => a.status === 200);
  out.errors_with_info = out.attempts.filter((a: any) =>
    a.status !== 404 && a.status !== 0 && a.status !== 200 && a.bodyLength > 30
  );
  out.total = out.attempts.length;
  return NextResponse.json(out);
}
