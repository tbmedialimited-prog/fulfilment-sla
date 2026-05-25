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
  } catch (e: any) {
    out.via_error = String(e?.message ?? e);
  }

  return NextResponse.json(out);
}
