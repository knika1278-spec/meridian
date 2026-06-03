import { NextResponse } from "next/server";
import { resolveDataDir } from "@/lib/data-source";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function readJsonArray<T>(dir: string, file: string): T[] {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(full, "utf-8")) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const dir = resolveDataDir();
    const positions = readJsonArray<Record<string, unknown>>(dir, "positions.json");
    const position = positions.find((p) => {
      const pk =
        typeof p.positionPubkey === "string" ? p.positionPubkey :
        typeof p.publicKey === "string" ? p.publicKey : undefined;
      return pk === id;
    });

    if (!position) {
      return NextResponse.json(
        { error: "Position not found" },
        { status: 404 },
      );
    }

    return NextResponse.json(position, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to load position: ${message}` },
      { status: 500 },
    );
  }
}
