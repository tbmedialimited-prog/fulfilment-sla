// Diagnostic - returns orders straight from getAllOrders with NO filtering.
// If this works but /api/orders doesn't, the bug is in /api/orders filtering.
import { NextResponse } from "next/server";
import { getAllOrders } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const orders = await getAllOrders(2000);
    return NextResponse.json({
      total: orders.length,
      first_5: orders.slice(0, 5).map(o => ({
        id: o.id,
        orderNumber: o.orderNumber,
        clientName: o.clientName,
        courierName: o.courierName,
        orderDate: o.orderDate,
        despatchDate: o.despatchDate,
        orderDate_type: typeof o.orderDate,
      })),
    });
  } catch (e: any) {
    return NextResponse.json({
      error: String(e?.message ?? e),
      stack: (e?.stack ?? "").split("\n").slice(0, 5),
    }, { status: 500 });
  }
}
