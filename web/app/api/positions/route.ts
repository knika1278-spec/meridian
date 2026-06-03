import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const dataDir = join(process.cwd(), "..", "data");
    const raw = readFileSync(join(dataDir, "positions.json"), "utf-8");
    const positions = JSON.parse(raw);
    return NextResponse.json(positions);
  } catch {
    return NextResponse.json([]);
  }
}
