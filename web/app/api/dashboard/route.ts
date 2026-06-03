import { NextResponse } from "next/server";
import { buildDashboard } from "@/lib/readers";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET() {
  try {
    return NextResponse.json(buildDashboard(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to build dashboard: ${message}` },
      { status: 500 },
    );
  }
}
