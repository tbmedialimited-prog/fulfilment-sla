// Diagnostic: fetch full Order detail from Mintsoft for one order
// to see what fields are available beyond what /Order/List returns
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const orderId = req.nextUrl.searchParams.get("id") || "";
  const apiKey = process.env.MINTSOFT_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "MINTSOFT_API_KEY missing" });
  if (!orderId) return NextResponse.json({ error: "pass ?id=<orderId>" });

  const endpoints = [
    `/api/Order/${orderId}`,
    `/api/Order/${orderId}/Detail`,
    `/api/Order/Detail?OrderId=${orderId}`,
    `/api/Order/${orderId}/Shipments`,
    `/api/Order/${orderId}/Tracking`,
    `/api/Order/${orderId}/Items`,
    `/api/Shipment?OrderId=${orderId}`,
  ];

  const out: any = { orderId, results: [] };
  for (const path of endpoints) {
    try {
      const res = await fetch("https://api.mintsoft.co.uk" + path, {
        headers: { "ms-apikey": apiKey, "Accept": "application/json" },
        cache: "no-store",
      });
      const text = await res.text();
      let data: any = null;
      try { data = JSON.parse(text); } catch {}
      out.results.push({
        path, status: res.status,
        keys: data && typeof data === "object" ? (Array.isArray(data) ? `array[${data.length}]` : Object.keys(data).slice(0, 50)) : null,
        body_preview: text.slice(0, 1500),
      });
    } catch (e: any) {
      out.results.push({ path, error: String(e?.message ?? e) });
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return NextResponse.json(out);
}
