# Meteora DLMM Screener Agent

Bot TypeScript untuk screening, membuka, memantau, dan menutup posisi LP di
Meteora DLMM. Bot membaca data pool dari Meteora, sinyal real-time dari Helius,
enrichment token dari Jupiter/OKX, lalu memakai LLM untuk keputusan
`ENTER`, `WATCH`, atau `SKIP`. Dashboard web membaca file state di `data/`
untuk menampilkan kandidat pool, sinyal, posisi, dan jurnal keputusan.

> Perhatian: konfigurasi saat ini mendukung live execution. Pastikan
> `src/config/user-config.json` dan `.env` sudah benar sebelum menjalankan mode
> non-dry-run.

## Quick Start

```bash
# install dependency bot
npm install

# siapkan environment
cp .env.example .env
# isi HELIUS_RPC_URL, HELIUS_WS_URL, WALLET_PRIVATE_KEY, JUPITER_API_KEY,
# OKX_API_KEY opsional, dan konfigurasi LLM sesuai provider

# cek TypeScript
npm run typecheck

# build production
npm run build

# sekali screening
npm run screen

# daemon screener + realtime + manager dalam satu proses
npm run auto
```

Dashboard:

```bash
cd web
npm install
npm run dev
# buka http://localhost:3000
```

## Script Utama

| Command | Fungsi |
|---|---|
| `npm run dev` | Menjalankan CLI via `tsx src/cli.ts`. |
| `npm run build` | Compile TypeScript ke `dist/`. |
| `npm run screen` | Satu siklus screening pool. |
| `npm run realtime` | Listener Helius WebSocket saja. |
| `npm run auto` | Mode daemon: scheduler screening, realtime listener, dan manager. |
| `npm test` | Test bawaan Node/tsx untuk `src/**/*.test.ts`. |

CLI yang tersedia mencakup `screen`, `start`, `manage`, `close`, `wallet`,
`realtime`, `candidates`, `config`, `positions`, `pnl`, `pool-detail`,
`active-bin`, `pool-ohlcv`, `pool-compare`, `study-pool`, `token-info`,
`token-holders`, `blacklist`, dan `pool-memory`.

## Arsitektur Singkat

```text
Meteora API + Helius RPC/WS + Jupiter/OKX
                  |
                  v
        src/tools/*  (adapter eksternal)
                  |
                  v
  ScreenerAgent -> LLM -> keputusan ENTER/WATCH/SKIP
        |                     |
        v                     v
  data/*.jsonl          ManagerAgent
        |                     |
        v                     v
  Web dashboard       MeteoraActions + Wallet
```

Komponen utama:

- `src/cli.ts`: entrypoint utama untuk screening, realtime, manager, research
  command, dan command operasional.
- `src/cli-manager.ts`: daemon manager mandiri untuk PM2; fokus pada lifecycle
  posisi, command queue, cleanup, capital rebalance, dan Telegram.
- `ScreenerAgent`: mengambil pool kandidat, menerapkan hard filter, enrichment,
  memory/learning context, lalu meminta keputusan LLM.
- `RealtimeListener`: subscribe ke program Meteora DLMM melalui Helius Enhanced
  WebSocket dan menyimpan snapshot sinyal terbaru.
- `ManagerAgent`: membuka posisi, mengevaluasi posisi aktif, claim fee, close,
  paper trading, post-close swap, dan penulisan outcome.
- `learning/*`: mencatat keputusan, outcome multi-horizon, shadow score,
  lesson mining, dan signal weights.
- `memory/*`: jurnal keputusan dan router konteks agar histori/lesson bisa
  disisipkan ke prompt.
- `web/*`: dashboard Next.js dengan custom server dan WebSocket broker `/ws`.

## Struktur Folder

```text
.
|-- src/
|   |-- agents/          Core bot: screener, manager, realtime, tracker, stores.
|   |-- config/          Loader Zod + user-config.json.
|   |-- learning/        Recorder, outcome collector, lesson miner, shadow ranker.
|   |-- llm/             Provider LLM: claude-cli dan MiMo-compatible API.
|   |-- memory/          Decision journal dan context router.
|   |-- notifications/   Integrasi Telegram.
|   |-- scripts/         Utility kecil seperti keypair, recheck, smoke LLM.
|   |-- shared/          Kontrak data lintas bot/web dan endpoint constants.
|   |-- tools/           Adapter Meteora, Helius, Jupiter, OKX, wallet, swap.
|   |-- types/           TypeScript contract bersama.
|   |-- utils/           Logger, formatter, JSONL emitter, command consumer.
|   `-- workers/         Eyes AI: analyzer, collector, reporter, handoff.
|-- web/
|   |-- app/             Next.js App Router dan API routes.
|   |-- components/      Komponen dashboard.
|   |-- hooks/           Hook polling/live data/count-up.
|   `-- lib/             Bridge JSONL, WebSocket broker, schema, formatting.
|-- prompts/             System prompt untuk screener, realtime, manager, eyes AI.
|-- data/                Runtime state dan history JSON/JSONL.
|-- findings/            Output analisis Eyes AI, report, raw context, handoff.
|-- docs/                Dokumentasi tambahan.
|-- scripts/             Script operasional di luar src.
|-- dist/                Hasil build TypeScript.
|-- logs/                Log PM2/runtime.
|-- ecosystem.config.cjs PM2: meteora-screener, meteora-manager, meteora-web.
`-- package.json         Script dan dependency root bot.
```

Folder `node_modules/`, `web/node_modules/`, `.next/`, `dist/`, `logs/`, dan
file arsip seperti `.rar` adalah artefak runtime/build, bukan source utama.

## Konfigurasi Penting

Konfigurasi utama ada di `src/config/user-config.json`:

- `rpc`: URL Helius RPC dan WebSocket.
- `meteora`, `jupiter`, `okx`, `meteoraPnl`: sumber data eksternal.
- `llm`: provider, model, temperature, batas token, dan limit call per cycle.
- `scheduler`: interval screening.
- `filters`: hard filter sebelum LLM, termasuk TVL, fee/active TVL, holders,
  market cap, bin step, OKX risk, token concentration, dan recent activity.
- `entryPolicy`: gate tambahan sebelum deploy, termasuk freshness dan collapse
  guard.
- `manager`: aturan posisi, ukuran deploy, range, threshold close/claim, file
  state, risk watcher, dan post-close swap.
- `capital`: rebalancing modal opsional.
- `learning` dan `memory`: pencatatan keputusan, outcome, lesson, shadow score,
  signal weights, serta konteks prompt.
- `dryRun`: satu sumber kebenaran untuk mode simulasi vs live execution.

Environment penting ada di `.env`: `HELIUS_RPC_URL`, `HELIUS_WS_URL`,
`WALLET_PRIVATE_KEY` (atau alias lama `PRIVATE_KEY_BOT`), `JUPITER_API_KEY`,
`OKX_API_KEY`, `MIMO_API_KEY`, `LLM_PROVIDER`, `TELEGRAM_BOT_TOKEN`, dan
`CHAT_ID`.

## Data Runtime

Bot dan dashboard berbagi data melalui `data/`:

| File | Isi |
|---|---|
| `candidates.jsonl` | Kandidat pool per siklus screening. |
| `llm-runs.jsonl` | Detail panggilan LLM dan keputusan. |
| `progress.jsonl` | Event progress screener/manager. |
| `decision-journal.jsonl` | Jurnal keputusan dan memori. |
| `realtime-signals.json` | Snapshot sinyal Helius terbaru. |
| `positions.json` | Posisi aktif. |
| `closed-positions.json` | Riwayat posisi tertutup. |
| `learning-*.jsonl` | Keputusan, outcome, lesson, dan snapshot learning. |
| `commands.jsonl` | Queue command dari dashboard/Telegram ke bot. |

Dashboard tidak menandatangani transaksi. Action seperti close/open ditulis ke
`data/commands.jsonl`, lalu proses bot/manager yang memprosesnya.

## PM2 Production

```bash
npm run build
cd web && npm run build && cd ..
pm2 start ecosystem.config.cjs
pm2 save
```

App PM2:

- `meteora-screener`: `dist/cli.js start --no-manager`.
- `meteora-manager`: `dist/cli-manager.js start`.
- `meteora-web`: `web/server.mjs` pada port `3000`.

Perintah berguna:

```bash
pm2 status
pm2 logs meteora-screener
pm2 logs meteora-manager
pm2 logs meteora-web
pm2 restart ecosystem.config.cjs
```

## License

MIT
