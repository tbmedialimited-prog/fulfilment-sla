import { NextResponse } from "next/server";
import { getAllOrders, isKvAvailable } from "@/lib/storage";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";

export async function GET() {
  const hasDb = isKvAvailable();
  const out: any = { has_database: hasDb };

  // Direct raw count
  try {
    const dburl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
    if (dburl) {
      const sql = neon(dburl);
      const cnt = await sql`SELECT COUNT(*)::int AS n FROM orders`;
      out.raw_count_in_db = (cnt[0] as any)?.n;
      const sample = await sql`SELECT id, order_number, client_id, client_name, courier_name, order_date, despatch_date FROM orders ORDER BY order_date DESC NULLS LAST LIMIT 3`;
      out.raw_sample_rows = sample;
    }
  } catch (e: any) {
    out.raw_error = String(e?.message ?? e);
  }

  // Then via storage layer
  try {
    const orders = await getAllOrders(5);
    out.via_getAllOrders_count = orders.length;
    out.via_getAllOrders_first = orders[0] ?? null;

    // Trace the filter that orders API uses
    if (orders[0]) {
      const o = orders[0];
      const now = Date.now();
      const cutoff365 = now - 365 * 24 * 3600 * 1000;
      const parsedDate = o.orderDate ? new Date(o.orderDate.includes("T") ? o.orderDate : o.orderDate.replace(" ", "T")) : null;
      const ts = parsedDate?.getTime() ?? NaN;
      out.filter_trace = {
        now_ms: now,
        now_iso: new Date(now).toISOString(),
        cutoff_365d_ms: cutoff365,
        cutoff_365d_iso: new Date(cutoff365).toISOString(),
        sample_orderDate_string: o.orderDate,
        sample_parsed_ts: ts,
        sample_parsed_iso: Number.isNaN(ts) ? null : new Date(ts).toISOString(),
        is_NaN: Number.isNaN(ts),
        passes_cutoff_check: !Number.isNaN(ts) && ts >= cutoff365,
      };
    }
  } catch (e: any) {
    out.via_error = String(e?.message ?? e);
    out.via_stack = (e?.stack ?? "").split("\n").slice(0, 5).join(" | ");
  }

  return NextResponse.json(out);
}
