# 🛠️ IMPLEMENTASI KOMPREHENSIF — Meteora DLMM Screener Agent Fix

## KONTEKS

Saya punya bot Meteora DLMM Screener Agent yang berjalan di Linux VPS via PM2.
Source code dikerjakan di Windows (D:\BOT\meteora\meteora-dlmm-screener-agent\),
lalu di-deploy manual ke VPS.

### Hasil Audit Sebelumnya (WAJIB BACA DULU)

Audit menemukan **akar masalah** bukan di filter terlalu ketat, tapi di
**learning system yang korup**:

- **C1** (KRITIS): `score-net-pnl-risk` membalikkan makna — token yang crash
  -99% dapat skor 0.95 "favorable". Semua learning dibangun di atas data salah.
- **C2** (KRITIS): Evidence korup di-inject ke setiap LLM prompt via
  `includeLearningEvidence:true` → menekan LLM untuk enter pool rug-prone.
- **C3** (MEDIUM): Shadow scores inflated → 243 "false disagreement" yang bilang
  bot terlalu konservatif.
- **M1** (MEDIUM): `maxLlmCandidates:3` membatasi throughput — 84% pool lolos
  filter tapi tidak pernah di-evaluate LLM.
- **M3** (MEDIUM): `maxDeploysPerCycle:1` membatasi multi-entry cycles.

### Strategi & Target

- Universe: trending 30m memecoin (disengaja, bukan bug)
- Goal: **lebih banyak entry** agar LLM lebih banyak belajar → seiring waktu
  lebih profitable
- Akan lanjut ke **live trading** (dryRun:false) setelah fix selesai
- Bot sudah buka 5 paper positions, **5/5 loss** (total -$48.13)
- Filters (TVL, organicScore, dll) **TIDAK perlu dilonggarkan** — 73% sudah
  lolos; longgar = lebih banyak toxic exposure

### Alur Kerja

File source di Windows: `D:\BOT\meteora\meteora-dlmm-screener-agent\`
Setelah fix selesai, saya akan manual deploy ke VPS.

---

## INSTRUKSI: 4 PHASE IMPLEMENTATION

**PENTING:** Kerjakan BERURUTAN dari Phase 1 → Phase 4.
Setiap phase punya **Validation Gate** — jangan lanjut ke phase berikutnya
sebelum validation gate terpenuhi.

---

### ═══════════════════════════════════════════
### PHASE 1 — FIX LEARNING CORRUPTION [C1 + C2]
### ═══════════════════════════════════════════

**Tujuan:** Hentikan learning system menghasilkan data sampah.

#### Step 1.1 — Inspect & Rewrite `score-net-pnl-risk.ts`

1. Baca file `src/learning/score-net-pnl-risk.ts` (atau cari dengan:
   ```bash
   Get-ChildItem -Path "D:\BOT\meteora\meteora-dlmm-screener-agent" -Recurse -Filter "*score*pnl*" | Select-Object FullName
   Get-ChildItem -Path "D:\BOT\meteora\meteora-dlmm-screener-agent" -Recurse -Filter "*net*pnl*" | Select-Object FullName
   ```
   Jika tidak ketemu, cari semua file yang mengandung "pnlRisk" atau "netPnlRiskScore":
   ```bash
   Select-String -Path "D:\BOT\meteora\meteora-dlmm-screener-agent\src\*.ts" -Pattern "netPnlRiskScore|pnlRisk" -Recurse | Select-Object -First 20
   ```

2. **Analisis logic saat ini** — identifikasi di mana:
   - `active_bin_drifted_out` dianggap neutral/baik (seharusnya = loss)
   - Fee/volume churn dianggap positif (padahal spike saat rug)
   - Price return dan impermanent loss TIDAK di-weight secara negatif

3. **Rewrite scoring logic** dengan prinsip:
   ```
   - Jika price turun >50% → score HARUS < 0.2 (toxic)
   - Jika price turun >80% → score HARUS < 0.05 (rug)
   - Jika active_bin_drifted_out = true → penalize, bukan neutral
   - Jika IL > fee earned → net negative, bukan positif
   - Fee/volume churn TIDAK boleh jadi faktor positif utama
   - Berat utama: priceReturn (50%) + IL impact (30%) + fee profit (20%)
   ```

4. **Tulis komentar di setiap perubahan** dengan format:
   ```
   // AUDIT FIX [C1]: [penjelasan kenapa diubah]
   ```

#### Step 1.2 — Disable Learning Evidence Injection [C2]

1. Cari file config yang mengatur `includeLearningEvidence`:
   ```bash
   Select-String -Path "D:\BOT\meteora\meteora-dlmm-screener-agent" -Pattern "includeLearningEvidence" -Recurse | Select-Object FullName, LineNumber, Line
   ```

2. Ubah `includeLearningEvidence: true` → `includeLearningEvidence: false`

3. Cari juga `memory.injectIntoScreener` atau sejenisnya:
   ```bash
   Select-String -Path "D:\BOT\meteora\meteora-dlmm-screener-agent" -Pattern "injectIntoScreener|inject.*learning|learning.*evidence" -Recurse
   ```
   Jika ada, set ke `false` juga.

4. **JANGAN hapus** file-file learning yang ada (outcomes, decisions, dll) —
   mereka akan di-recompute di Phase 2.

#### Step 1.3 — Check for Other Corrupted Scoring Surfaces

Select-String -Path "D:\BOT\meteora\meteora-dlmm-screener-agent\src" -Pattern "entry_market_proxy|marketProxy|fee.volume.churn" -Recurse


Jika `entry_market_proxy` dipakai di tempat lain selain score-net-pnl-risk,
identifikasi dan perbaiki juga.

### ✅ VALIDATION GATE PHASE 1

Setelah Phase 1 selesai, lakukan pengecekan:

1. **Code review**: Tunjukkan diff dari semua perubahan yang dibuat
2. **Logic test**: Buat contoh skenario manual:
   - Token turun 99% → skor harus < 0.05
   - Token turun 50% → skor harus < 0.2
   - Token naik 200%, IL rendah → skor harus > 0.8
   - Token flat, fee > IL → skor harus ~0.5
3. **Config check**: Konfirmasi `includeLearningEvidence: false` sudah aktif
4. **Tanya saya**: "Phase 1 selesai, mau lanjut Phase 2?"

---

### ═══════════════════════════════════════════
### PHASE 2 — RESET & RE-LEARN [C3 Auto-Resolve]
### ═══════════════════════════════════════════

**Tujuan:** Reset data learning yang korup dan bersihkan noise dari
shadow scores dan signal weights.

#### Step 2.1 — Backup Data Lama

Sebelum reset, buat backup:
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss" $backupDir = "D:\BOT\meteora\meteora-dlmm-screener-agent\data\backup-$timestamp" New-Item -ItemType Directory -Path $backupDir Copy-Item "D:\BOT\meteora\meteora-dlmm-screener-agent\data\learning-outcomes.jsonl" $backupDir Copy-Item "D:\BOT\meteora\meteora-dlmm-screener-agent\data\learning-decisions.jsonl" $backupDir Copy-Item "D:\BOT\meteora\meteora-dlmm-screener-agent\data\learning-snapshot.jsonl" $backupDir Copy-Item "D:\BOT\meteora\meteora-dlmm-screener-agent\data\learning-lessons.jsonl" $backupDir Copy-Item "D:\BOT\meteora\meteora-dlmm-screener-agent\data\lessons.json" $backupDir Copy-Item "D:\BOT\meteora\meteora-dlmm-screener-agent\data\shadow-scores.jsonl" $backupDir Copy-Item "D:\BOT\meteora\meteora-dlmm-screener-agent\data\signal-weights.json" $backupDir


#### Step 2.2 — Reset Corrupted Learning Data

Tentukan file mana yang perlu di-reset vs di-recompute:

1. **Reset (hapus isi, mulai dari nol)**:
   - `learning-outcomes.jsonl` → skor semua salah, harus re-score dari awal
   - `shadow-scores.jsonl` → inflated, harus recompute
   - `learning-lessons.jsonl` → lessons dari data korup
   - `lessons.json` → sama

2. **Recompute (jalankan ulang dengan scoring baru)**:
   - Cari script yang bisa recompute outcomes dari closed-positions:
     ```bash
     Select-String -Path "D:\BOT\meteora\meteora-dlmm-screener-agent\src" -Pattern "recompute|reprocess|re-score|backfill" -Recurse
     ```
   - Jika ada, jalankan dengan scoring logic baru
   - Jika tidak ada, buat script `recompute-outcomes.ts` yang:
     a. Baca `closed-positions.json` (data positions yang sudah ditutup)
     b. Baca `candidates.jsonl` (data original pools)
     c. Hitung ulang `netPnlRiskScore` dengan logic baru
     d. Output ke `learning-outcomes.jsonl` yang baru

3. **Reset signal-weights** ke baseline:
   - Baca `signal-weights.json`
   - Karena weights terbentuk dari learning yang korup, reset ke default/flat
   - Biarkan learning system membangun ulang weights dari data bersih

#### Step 2.3 — Verify Re-learned Data

1. Baca sample dari `learning-outcomes.jsonl` yang baru
2. Pastikan token yang crash >50% dapat skor < 0.2 (bukan 0.95 lagi)
3. Hitung rata-rata skor — harus turun signifikan dari 0.919

### ✅ VALIDATION GATE PHASE 2

1. **Sampling check**: Ambil 10 token terburuk dari data → semua harus skor rendah
2. **Distribution check**: Distribusi skor harus masuk akal (bukan semua >0.9)
3. **Tanya saya**: "Phase 2 selesai. Data learning sudah bersih. Mau lanjut
   Phase 3?"

**CATATAN:** Setelah Phase 2, jalankan bot di mode **dryRun:true** selama
**minimal 24-48 jam** untuk memberi waktu learning system belajar dari data
bersih sebelum lanjut Phase 3. Ini sangat penting.

---

### ═══════════════════════════════════════════
### PHASE 3 — RAISE THROUGHPUT [M1 + M3]
### ═══════════════════════════════════════════

**Tujuan:** Tingkatkan jumlah entry agar LLM lebih banyak belajar.

**PRASYARAT:** Phase 2 sudah selesai + bot sudah jalan 24-48 jam dengan
learning system yang bersih.

#### Step 3.1 — Raise LLM Candidate Cap [M1]

Cari dan ubah `maxLlmCandidates`:
Select-String -Path "D:\BOT\meteora\meteora-dlmm-screener-agent" -Pattern "maxLlmCandidates|LlmCandidate" -Recurse


Ubah: `maxLlmCandidates: 3` → `maxLlmCandidates: 6`

**Alasan tidak langsung 8**: Naikkan bertahap. Dari 3→6 = 2x throughput.
Monitor 24 jam dulu, kalau stabil baru naikkan ke 8.

#### Step 3.2 — Raise Deploy Per Cycle [M3]

Cari dan ubah `maxDeploysPerCycle`:
Select-String -Path "D:\BOT\meteora\meteora-dlmm-screener-agent" -Pattern "maxDeploysPerCycle|DeployPerCycle" -Recurse


Ubah: `maxDeploysPerCycle: 1` → `maxDeploysPerCycle: 2`

#### Step 3.3 — Check maxOpenPositions

Select-String -Path "D:\BOT\meteora\meteora-dlmm-screener-agent" -Pattern "maxOpenPositions|MaxOpen" -Recurse


Pastikan `maxOpenPositions` >= 3 (agar 2 deploy/cycle bisa jalan dengan
1 position lama masih aktif).

#### Step 3.4 — Re-enable Learning Evidence (SETENGAH)

Setelah learning system sudah menghasilkan data bersih (Phase 2 + 24-48 jam
running), pertimbangkan:
- `includeLearningEvidence: true` TAPI dengan **filter threshold**
- Hanya inject evidence yang skor-nya **di atas 0.7** (data bersih)
- Jangan inject evidence yang skor-nya < 0.3 (toxic pools)

Cari mekanisme filtering di:
Select-String -Path "D:\BOT\meteora\meteora-dlmm-screener-agent\src" -Pattern "includeLearningEvidence|learningEvidence.filter|evidence.threshold" -Recurse


Jika tidak ada filter threshold, tambahkan di injection logic:
// AUDIT FIX [C2-MITIGATED]: Only inject high-confidence learning evidence if (includeLearningEvidence && outcome.score > 0.7) { // inject ke prompt }


### ✅ VALIDATION GATE PHASE 3

1. **Config check**: Semua parameter sudah diubah sesuai step
2. **Bot test**: Jalankan bot di dryRun:true, monitor 2-3 cycle:
   - Berapa pool yang masuk LLM evaluation (dari 3 → seharusnya 6)
   - Berapa ENTER yang di-generate
   - Apakah learning evidence yang di-inject sudah bersih
3. **Tanya saya**: "Phase 3 selesai, throughput sudah naik. Mau lanjut
   Phase 4 (live trading prep)?"

---

### ═══════════════════════════════════════════
### PHASE 4 — LIVE TRADING SAFETY GATES
### ═══════════════════════════════════════════

**Tujuan:** Pastikan bot aman untuk live trading dengan kontrol kerugian.

#### Step 4.1 — Spend Limits

Cek apakah sudah ada spend limit:
Select-String -Path "D:\BOT\meteora\meteora-dlmm-screener-agent" -Pattern "spendLimit|maxSpend|dailyLimit|MAX_SINGLE|MAX_DAILY|positionSize|tradeAmount" -Recurse


Jika BELUM ada, tambahkan di config:
LIVE TRADING SAFETY
safety: maxSingleTradeUSD: 50 # Maksimal $50 per entry maxDailySpendUSD: 200 # Maksimal $200 per hari maxDailyTrades: 10 # Maksimal 10 trades per hari maxOpenPositions: 3 # Maksimal 3 posisi bersamaan maxDailyLossUSD: 100 # STOP jika rugi > $100/hari maxTotalDrawdownPct: 0.15 # STOP jika drawdown > 15% dari portfolio


#### Step 4.2 — Circuit Breaker

Cek apakah sudah ada circuit breaker:
Select-String -Path "D:\BOT\meteora\meteora-dlmm-screener-agent" -Pattern "circuitBreaker|circuit_breaker|haltTrading|emergencyStop|killSwitch" -Recurse


Jika belum ada, tambahkan logic:
// LIVE TRADING SAFETY: Circuit Breaker class TradingCircuitBreaker { MAX_CONSECUTIVE_LOSSES = 3; // Stop setelah 3 loss berturut-turut MAX_HOURLY_LOSS_PCT = 0.05; // Stop jika rugi > 5% dalam 1 jam

check(portfolioValue: number): void { if (this.consecutiveLosses >= this.MAX_CONSECUTIVE_LOSSES) { this.halt("Too many consecutive losses — manual review required"); } // ... hourly loss check } }


#### Step 4.3 — Gradual Ramp-Up Strategy

JANGAN langsung jalankan bot dengan penuh. Buat rencana ramp-up:

Hari 1-2: dryRun:false, maxDailyTrades:2, maxSingleTradeUSD:10 Hari 3-4: dryRun:false, maxDailyTrades:4, maxSingleTradeUSD:20 Hari 5-7: dryRun:false, maxDailyTrades:6, maxSingleTradeUSD:30 Hari 8+: dryRun:false, maxDailyTrades:10, maxSingleTradeUSD:50


Cari tempat config ramp-up:
Select-String -Path "D:\BOT\meteora\meteora-dlmm-screener-agent" -Pattern "dryRun|dry_run|paperMode|paper_mode|observeMode" -Recurse


Ubah `dryRun: true` → `dryRun: false` dengan limits di atas.

#### Step 4.4 — Pre-Live Checklist

Buat file `PRE-LIVE-CHECKLIST.md` di root project:

Pre-Live Checklist
Harus Selesai Sebelum dryRun:false:
[ ] C1 fixed: score-net-pnl-risk sudah di-rewrite
[ ] C2 fixed: includeLearningEvidence sudah di-manage
[ ] Data learning sudah di-reset dan re-learned (24-48 jam)
[ ] Spend limits terkonfigurasi
[ ] Circuit breaker aktif
[ ] OKX API key punya permission yang benar
[ ] OKX wallet balance mencukupi (minimal $100 USDC)
[ ] Bot running stabil 24 jam tanpa crash
[ ] Signal distribution masuk akal (ENTER > 5% dari DECIDED)
Harus Monitor Setelah Live:
[ ] Cek PnL setiap 6 jam di hari pertama
[ ] Cek logs untuk error baru
[ ] Pastikan circuit breaker tidak trigger terlalu cepat
[ ] Review 3-5 trades pertama secara manual

### ✅ VALIDATION GATE PHASE 4

1. **Safety check**: Semua limits terkonfigurasi dan ter-test
2. **Ramp-up plan**: Disetujui oleh owner (Anda)
3. **Pre-live checklist**: Semua item ter-centang
4. **Tanya saya**: "Semua phase selesai. Bot siap live. Mau saya bantu
   monitoring plan juga?"

---

## RINGKASAN PERUBAHAN

Setelah semua phase selesai, berikut daftar lengkap file yang diubah:

| Phase | File | Perubahan |
|---|---|---|
| 1 | `score-net-pnl-risk.ts` | Rewrite scoring logic |
| 1 | config (`includeLearningEvidence`) | Set false sementara |
| 2 | `learning-outcomes.jsonl` | Reset + recompute |
| 2 | `shadow-scores.jsonl` | Reset |
| 2 | `signal-weights.json` | Reset ke baseline |
| 3 | config (`maxLlmCandidates`) | 3 → 6 |
| 3 | config (`maxDeploysPerCycle`) | 1 → 2 |
| 3 | config (`includeLearningEvidence`) | true (dengan filter) |
| 4 | config (safety limits) | Tambah spend limits |
| 4 | source (circuit breaker) | Tambah jika belum ada |
| 4 | config (`dryRun`) | true → false (gradual) |

---

## CATATAN PENTING

▎ ⚠️ **JANGAN skip Phase 2.** Tanpa reset data learning yang korup,
▎ Phase 3 (lebih banyak entry) akan menghasilkan lebih banyak loss karena
▎ LLM masih "belajar" dari data yang salah.
▎
▎ ⚠️ **JANGAN langsung Phase 4 tanpa Phase 2 + 24-48 jam dryRun.**
▎ Learning system butuh waktu belajar dari data bersih sebelum aman
▎ untuk live trading.
▎
▎ ⚠️ **Filters (TVL, organicScore, dll) TIDAK diubah.** Audit menunjukkan
▎ 73% sudah lolos filter. Yang bottleneck adalah maxLlmCandidates:3, bukan filters.