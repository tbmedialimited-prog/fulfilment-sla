import { NextRequest, NextResponse } from "next/server";
import { getAllOrders } from "@/lib/storage";
import { warehouseSlaMet, deliverySlaMet, transitHours, percentile } from "@/lib/sla";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const days = Number(req.nextUrl.searchParams.get("days") ?? 30);
  const clientFilter = req.nextUrl.searchParams.get("client");
  const courierFilter = req.nextUrl.searchParams.get("courier");

  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const all = await getAllOrders(5000);

  const orders = all.filter(o => {
    if (!o.orderDate) return false;
    const t = new Date(o.orderDate.includes("T") ? o.orderDate : o.orderDate.replace(" ", "T")).getTime();
    if (Number.isNaN(t) || t < cutoff) return false;
    if (clientFilter && String(o.clientId) !== clientFilter && o.clientName !== clientFilter) return false;
    if (courierFilter && !(o.courierName ?? "").toLowerCase().includes(courierFilter.toLowerCase())) return false;
    return true;
  });

  const dispatched = orders.filter(o => o.despatchDate);
  const delivered = orders.filter(o => o.deliveredDate);
  const whEligible = orders.filter(o => o.orderDate && o.despatchDate);
  const whMet = whEligible.filter(o => warehouseSlaMet(o.orderDate, o.despatchDate) === true);
  const delEligible = delivered.filter(o => o.despatchDate);
  const delMet = delEligible.filter(o => deliverySlaMet(o.despatchDate, o.deliveredDate) === true);
  const transits = delivered
    .map(o => transitHours(o.despatchDate, o.deliveredDate))
    .filter((x): x is number => x !== null);

  return NextResponse.json({
    total_orders: orders.length,
    dispatched: dispatched.length,
    delivered: delivered.length,
    in_transit: dispatched.length - delivered.length,
    warehouse_sla: {
      eligible: whEligible.length,
      met: whMet.length,
      rate: whEligible.length ? Math.round((whMet.length / whEligible.length) * 1000) / 10 : null,
    },
    delivery_sla: {
      eligible: delEligible.length,
      met: delMet.length,
      rate: delEligible.length ? Math.round((delMet.length / delEligible.length) * 1000) / 10 : null,
    },
    transit_hours: {
      n: transits.length,
      mean: transits.length ? Math.round(transits.reduce((a, b) => a + b, 0) / transits.length * 10) / 10 : null,
      median: transits.length ? Math.round(percentile(transits, 50)! * 10) / 10 : null,
      p90: transits.length ? Math.round(percentile(transits, 90)! * 10) / 10 : null,
    },
  });
}
