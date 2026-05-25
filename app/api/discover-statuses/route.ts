// Diagnostic: discover Mintsoft order statuses
import { NextResponse } from "next/server";
import { discoverStatuses } from "@/lib/mintsoft";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const result = await discoverStatuses();
    return NextResponse.json({
      hint: "Lists which OrderStatusId values return data and a sample of the first order in each.",
      statuses: result,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
