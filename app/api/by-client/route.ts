import { NextRequest, NextResponse } from "next/server";
import { getAllOrders } from "@/lib/storage";
import { warehouseSlaMet, deliverySlaMet, transitHours, percentile } from "@/lib/sla";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const days = Number(req.nextUrl.searchParams.get("days") ?? 30);
  const courierFilter = req.nextUrl.searchParams.get("courier");
  const cutoff = Date.now() - days * 24 * 3600 * 1000;

  const all = await getAllOrders(2000);
  const filtered = all.filter(o => {
    if (!o.orderDate) return false;
    const t = new Date(o.orderDate.includes("T") ? o.orderDate : o.orderDate.replace(" ", "T")).getTime();
    if (Number.isNaN(t) || t < cutoff) return false;
    if (courierFilter && !(o.courierName ?? "").toLowerCase().includes(courierFilter.toLowerCase())) return false;
    return true;
  });

  const groups = new Map<string, typeof filtered>();
  for (const o of filtered) {
    const key = o.clientName ?? `Client ${o.clientId}` ?? "(unknown)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(o);
  }

  const out = Array.from(groups.entries()).map(([client, group]) => {
    const whEligible = group.filter(o => o.orderDate && o.despatchDate);
    const whMet = whEligible.filter(o => warehouseSlaMet(o.orderDate, o.despatchDate) === true);
    const delivered = group.filter(o => o.deliveredDate);
    const delMet = delivered.filter(o => deliverySlaMet(o.despatchDate, o.deliveredDate) === true);
    const transits = delivered
      .map(o => transitHours(o.despatchDate, o.deliveredDate))
      .filter((x): x is number => x !== null);
    return {
      client,
      total_orders: group.length,
      dispatched: group.filter(o => o.despatchDate).length,
      delivered: delivered.length,
      warehouse_sla_rate: whEligible.length ? Math.round((whMet.length / whEligible.length) * 1000) / 10 : null,
      delivery_sla_rate: delivered.length ? Math.round((delMet.length / delivered.length) * 1000) / 10 : null,
      median_transit_hours: transits.length ? Math.round(percentile(transits, 50)! * 10) / 10 : null,
      p90_transit_hours: transits.length ? Math.round(percentile(transits, 90)! * 10) / 10 : null,
    };
  });
  out.sort((a, b) => b.total_orders - a.total_orders);
  return NextResponse.json(out);
}
