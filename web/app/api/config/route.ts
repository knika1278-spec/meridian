import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

const CONFIG_PATH = path.resolve(
  process.cwd(),
  "../src/config/user-config.json",
);

function readConfig(): Record<string, unknown> {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw);
}

function writeConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/** GET — return full config. */
export function GET() {
  try {
    const config = readConfig();
    return NextResponse.json(config, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to read config: ${message}` },
      { status: 500 },
    );
  }
}

/** PATCH — merge partial update into config. Supports nested keys via dot notation. */
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    const config = readConfig();

    // Support both flat merges and dot-notation paths
    for (const [key, value] of Object.entries(body)) {
      if (key.includes(".")) {
        const parts = key.split(".");
        let target: Record<string, unknown> = config;
        for (let i = 0; i < parts.length - 1; i++) {
          const part = parts[i]!;
          if (typeof target[part] !== "object" || target[part] === null) {
            target[part] = {};
          }
          target = target[part] as Record<string, unknown>;
        }
        target[parts[parts.length - 1]!] = value;
      } else {
        config[key] = value;
      }
    }

    writeConfig(config);

    return NextResponse.json({ ok: true, config });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to update config: ${message}` },
      { status: 500 },
    );
  }
}
