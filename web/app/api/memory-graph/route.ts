import { NextResponse } from "next/server";
import { buildGraph } from "@/lib/build-graph";
import { loadRawData } from "@/lib/data-source";

// Always read fresh from disk so the live poll reflects the agent's latest memory.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET() {
  try {
    const graph = buildGraph(loadRawData());
    return NextResponse.json(graph, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to build memory graph: ${message}` },
      { status: 500 },
    );
  }
}
