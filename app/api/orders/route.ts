import { NextRequest, NextResponse } from "next/server";
import { getAllOrders } from "@/lib/storage";
import { warehouseSlaMet, deliverySlaMet, transitHours } from "@/lib/sla";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const days = Number(req.nextUrl.searchParams.get("days") ?? 30);
  const clientFilter = req.nextUrl.searchParams.get("client");
  const courierFilter = req.nextUrl.searchParams.get("courier");
  const status = req.nextUrl.searchParams.get("status"); // delivered|in_transit|breached
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 200);

  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const all = await getAllOrders(2000);

  let orders = all.filter(o => {
    if (!o.orderDate) return false;
    const t = new Date(o.orderDate.includes("T") ? o.orderDate : o.orderDate.replace(" ", "T")).getTime();
    if (Number.isNaN(t) || t < cutoff) return false;
    if (clientFilter && o.clientName !== clientFilter && String(o.clientId) !== clientFilter) return false;
    if (courierFilter && !(o.courierName ?? "").toLowerCase().includes(courierFilter.toLowerCase())) return false;
    return true;
  });

  if (status === "delivered") orders = orders.filter(o => o.deliveredDate);
  else if (status === "in_transit") orders = orders.filter(o => o.despatchDate && !o.deliveredDate);
  else if (status === "breached") {
    orders = orders.filter(o => {
      const w = warehouseSlaMet(o.orderDate, o.despatchDate);
      const d = deliverySlaMet(o.despatchDate, o.deliveredDate);
      return w === false || d === false;
    });
  }

  orders.sort((a, b) => {
    const ta = new Date(a.orderDate.includes("T") ? a.orderDate : a.orderDate.replace(" ", "T")).getTime();
    const tb = new Date(b.orderDate.includes("T") ? b.orderDate : b.orderDate.replace(" ", "T")).getTime();
    return tb - ta;
  });

  const total = orders.length;
  const slice = orders.slice(0, limit).map(o => ({
    id: o.id,
    order_number: o.orderNumber,
    client: o.clientName ?? `Client ${o.clientId}`,
    courier: o.courierName,
    tracking_number: o.trackingNumber,
    postcode: o.postcode,
    country: o.countryCode,
    order_date: o.orderDate,
    despatch_date: o.despatchDate,
    delivered_date: o.deliveredDate,
    warehouse_sla_met: warehouseSlaMet(o.orderDate, o.despatchDate),
    delivery_sla_met: deliverySlaMet(o.despatchDate, o.deliveredDate),
    transit_hours: transitHours(o.despatchDate, o.deliveredDate),
    tracking_status: o.trackingStatus,
    last_event: o.lastEvent,
  }));

  return NextResponse.json({ total, returned: slice.length, orders: slice });
}
