# Logika Bot Saat Ini

Dokumen ini hanya menjelaskan logika pengambilan keputusan bot saat ini. Fokus
utamanya: alur screener, `entryPolicy`, `collapseGuard`, validasi sebelum open,
manager posisi, learning/outcome, dan rancangan eksperimen shadow-test LLM vs
rule-based.

## Ringkasan Alur

```text
Helius realtime signal
        |
        v
Screener cycle
  fetch Meteora pools
  enrich token/risk data
  hard filters + entryPolicy
  pilih kandidat LLM terbatas
  LLM: ENTER/WATCH/SKIP
  deploy gate + collapseGuard
        |
        v
Manager open / paper open
  fresh validation
  sizing guard
  open position
        |
        v
Manager cycle
  evaluate position
  heuristic close/claim/hold
  optional manager LLM
  execute action
        |
        v
Learning
  record decision
  compute outcome by horizon
  cohort evidence
  shadow disagreement
  lessons + signal weights
```

## 1. Realtime Signal

Sumber: `src/agents/realtime.listener.ts`.

Bot subscribe ke Helius `transactionSubscribe` dengan filter
`accountInclude` pada program Meteora DLMM. Setiap transaksi yang relevan
diklasifikasikan menjadi:

- `new_pool`
- `liquidity_add`
- `liquidity_remove`
- `swap`
- `volume_spike`
- `active_bin_change`
- `unknown` (diabaikan untuk event yang tidak bisa diklasifikasi)

Logika penting:

- Signature transaksi dideduplikasi agar satu transaksi tidak dihitung dua kali.
- Buffer global menyimpan 500 event terakhir.
- Buffer per pool menyimpan 50 event terakhir.
- `volume_spike` dibuat jika ada minimal 5 swap dalam 60 detik untuk pool yang
  sama, dengan throttle 60 detik.
- Snapshot realtime ditulis ke `data/realtime-signals.json`.

Realtime signal ini dipakai oleh:

- Screener untuk `entryPolicy`.
- LLM prompt sebagai konteks aktivitas terakhir.
- Manager untuk validasi fresh sebelum open.

## 2. Screener Cycle

Sumber utama: `src/agents/screener.agent.ts`.

Satu siklus screener berjalan seperti ini:

1. Ambil pool kandidat dari Meteora, sort utama `fees_24h`.
2. Enrich token via Jupiter dan OKX secara best-effort.
3. Bangun `ScreeningResult` per pool.
4. Terapkan hard filters.
5. Ambil recent realtime events per pool.
6. Evaluasi `entryPolicy`.
7. Jika lolos filter, resolve active bin/current price on-chain.
8. Urutkan kandidat untuk LLM.
9. Panggil LLM hanya sampai batas konfigurasi.
10. Simpan hasil ke JSONL dan decision journal.
11. Untuk LLM `ENTER`, jalankan deploy gate dan serahkan ke manager/open.

## 3. Hard Filters

Hard filters adalah gate sebelum LLM. `filtersPassed` bernilai true hanya jika
semua entry pada `filterReport` pass.

Gate yang dipakai saat ini:

- `blacklist`: reject jika salah satu token mint masuk blacklist.
- `poolCooldown`: reject jika pool sedang cooldown di `pool-memory`.
- `feeActiveTvlRatio`: `feesWindow / activeTvl * 100` harus >= threshold.
- `organicScore`, `holders`, `marketCap`: diterapkan ke token spekulatif,
  bukan token quote yang ada di `includedTokens`.
- `binStep`: harus dalam range konfigurasi.
- `tvl`: harus dalam range konfigurasi.
- `volume24h`: harus >= minimum jika dikonfigurasi.
- `minTokenFeesSol`: lolos jika data tidak tersedia atau memenuhi minimum.
- `maxBundlersPct`: lolos jika data tidak tersedia atau di bawah maksimum.
- `maxTop10Pct`: lolos jika data tidak tersedia atau di bawah maksimum.
- `blockedLaunchpads`: reject jika launchpad token ada di daftar blokir.
- `excludedTokens`: reject jika token ada di daftar exclude.
- `includedTokens`: harus tepat satu sisi pool yang termasuk quote token
  (XOR). Ini mencegah pair quote-vs-quote.
- `okxRiskScore`: lolos jika data tidak tersedia atau risk score <= maksimum.
- `okxCriticalRisk`: reject jika OKX menandai honeypot/wash.
- `smartMoneyNetFlow`: lolos jika data tidak tersedia atau flow >= minimum.
- `mintAuthorityDisabled` dan `freezeAuthorityDisabled`: hanya aktif jika
  diwajibkan di config.
- `recentActivity`: jika `requireRecentActivity=true` dan listener aktif,
  pool harus punya recent realtime event.

Catatan penting: beberapa data OKX yang tidak tersedia dibuat pass-through pada
hard filter. Namun `collapseGuard` bisa tetap memblokir ENTER jika risk data
diwajibkan.

## 4. entryPolicy

Sumber: `src/utils/entry-policy.ts`.

`entryPolicy` adalah gate berbasis realtime signal. Ia memeriksa apakah pool
yang terlihat menarik di API juga benar-benar punya aktivitas on-chain terbaru.

Kondisi gagal:

- Tidak ada realtime signal.
- Signal terbaru lebih tua dari `maxSignalAgeMs`.
- Jumlah `swap` kurang dari `minSwaps`.
- Jumlah slot unik kurang dari `minDistinctSlots`.
- `liquidity_remove - liquidity_add` lebih besar dari `maxRemoveMinusAdd`.

Nilai aktif saat ini dari `src/config/user-config.json`:

```json
{
  "entryPolicy": {
    "enabled": true,
    "mode": "enforce",
    "maxLlmCandidates": 3,
    "maxDeploysPerCycle": 1,
    "realtime": {
      "maxSignalAgeMs": 180000,
      "minSwaps": 3,
      "minDistinctSlots": 2,
      "maxRemoveMinusAdd": 1
    }
  }
}
```

Mode:

- `enforce`: kegagalan entry policy membuat pool gagal filter/deploy.
- `observe`: kegagalan dicatat, tetapi tidak memblokir.

## 5. Pemilihan Kandidat LLM

LLM tidak dipanggil untuk semua pool yang lolos. Pool diurutkan memakai skor
rule-based awal:

```text
preLlmScore =
  feeActiveTvlRatioPct * 100
  + volumeTvlRatioPct * 20
  + realtime.swaps * 5
  + realtime.liquidityAdds * 3
  - realtime.liquidityRemoves * 8
```

Setelah itu jumlah call LLM dibatasi oleh nilai minimum dari:

- `llm.maxCallsPerScreenCycle`
- `entryPolicy.maxLlmCandidates`

Dengan konfigurasi saat ini, maksimal 3 kandidat per siklus masuk LLM.

Prompt LLM berisi:

- Snapshot pool.
- Token X/Y dan risk/enrichment.
- `filterReport`.
- `entryPolicy`.
- Range guidance berdasarkan bin step.
- Ringkasan realtime signal.
- `signalHints` dari learning jika tersedia.
- Memory bundle: recent decisions, lessons, learning evidence.

Output LLM wajib JSON:

```json
{
  "action": "ENTER | WATCH | SKIP",
  "confidence": 0.0,
  "reasons": [],
  "risks": [],
  "suggestedSizeUsd": 0,
  "suggestedRangeBps": 0,
  "notes": ""
}
```

Jika JSON invalid atau tidak lolos schema, keputusan diabaikan. Jika LLM
memberi `suggestedRangeBps` terlalu agresif, range dikunci oleh range guard.

## 6. Deploy Gate Setelah LLM ENTER

LLM `ENTER` belum berarti bot langsung open. Masih ada deploy gate:

1. Hanya hasil dengan `filtersPassed=true` yang dipertimbangkan.
2. Semua ENTER diranking lagi memakai `scoreEnterCandidate`.
3. Hanya top N sesuai `entryPolicy.maxDeploysPerCycle` yang boleh lanjut.
4. `collapseGuard` dievaluasi ulang.
5. Jika `dryRun=true`, bot mencatat `WOULD_OPEN` dan bisa membuka paper
   position jika `paperTrading.openOnDryRun=true`.
6. Jika `dryRun=false`, open diteruskan ke manager langsung atau melalui
   command queue, tergantung mode proses.

Skor deploy:

```text
enterScore =
  llmConfidence * 10000
  + feeActiveTvlRatioPct * 100
  + volumeTvlRatioPct * 20
  + realtime.swaps * 5
  + realtime.liquidityAdds * 3
  + realtime.volumeSpikes * 2
  - realtime.liquidityRemoves * 8
  - llmRiskCount * 2
```

Karena bobot confidence sangat besar, LLM confidence menjadi faktor dominan di
antara kandidat ENTER.

## 7. collapseGuard

Sumber: `src/utils/entry-policy.ts`.

`collapseGuard` adalah gate tambahan untuk mencegah masuk ke token yang tampak
sedang collapse/rug-risk meskipun metrik fee atau volume terlihat bagus.

Ia mengecek token yang dianggap non-quote/spekulatif. Jika `includedTokens`
berisi quote seperti SOL/USDC, token quote dikecualikan dan token sebelahnya
yang diperiksa.

Kondisi gagal:

- Tidak ada token non-quote yang bisa discreen.
- Risk data hilang saat `requireRiskDataForEnter=true`.
- `devSoldAll=true` saat `blockDevSoldAll=true`.
- `priceVsAthPct` lebih rendah dari minimum.
- `devRugCount` lebih besar dari maksimum.
- `devTokenCount` lebih besar dari maksimum.
- `sniperPct` lebih besar dari maksimum.

Nilai aktif saat ini:

```json
{
  "collapseGuard": {
    "enabled": true,
    "mode": "enforce",
    "requireRiskDataForEnter": true,
    "blockDevSoldAll": true,
    "priceVsAthPctMin": 65,
    "maxDevRugCount": 0,
    "maxDevTokenCount": 50,
    "maxSniperPct": 5,
    "microStabilityDelayMs": 2500,
    "microMaxActiveBinDriftBins": 2,
    "microMaxPriceMovePct": 1.5
  }
}
```

Di flow saat ini, `collapseGuard` penting di dua tempat:

- Saat auto-open ENTER: jika gagal dan mode `enforce`, deploy diblokir.
- Saat fresh validation di manager: dicek ulang memakai data pool terbaru.

## 8. Fresh Validation Sebelum Open

Sumber: `src/utils/entry-policy.ts` dan `src/agents/manager.agent.ts`.

Sebelum manager membuka posisi, bot tidak percaya penuh pada snapshot saat LLM
membuat keputusan. Ia melakukan validasi ulang:

1. `entrySnapshot` harus ada untuk auto-enter saat mode `enforce`.
2. Fetch fresh pool dari Meteora dan enrich active bin/current price on-chain.
3. Jalankan fresh hard filters.
4. Jalankan `collapseGuard`.
5. Ambil realtime event terbaru dari listener, command snapshot, atau
   `data/realtime-signals.json`.
6. Jalankan ulang `entryPolicy`.
7. Cek umur snapshot <= `freshness.maxSnapshotAgeMs`.
8. Cek drift active bin dari snapshot <= `freshness.maxActiveBinDriftBins`.
9. Cek price move dari snapshot <= `freshness.maxPriceMovePct`.
10. Jalankan micro-stability check: tunggu `microStabilityDelayMs`, fetch pool
    lagi, lalu cek drift bin dan price move mikro.

Nilai freshness aktif:

```json
{
  "freshness": {
    "maxSnapshotAgeMs": 60000,
    "maxActiveBinDriftBins": 2,
    "maxPriceMovePct": 2.5
  }
}
```

Jika mode `observe`, kegagalan fresh validation dicatat tetapi open tetap boleh
lanjut. Jika mode `enforce`, open diblokir.

## 9. Position Sizing Saat Open

Manager membuka posisi hanya jika belum melewati `manager.maxOpenPositions`.

Urutan sizing:

1. Jika `manager.positionSizeUsd` ada dan > 0, pakai nilai itu.
2. Jika ada konfigurasi SOL-based sizing, cek wallet:
   - `minSolToOpen`
   - `gasReserve`
   - `deployAmountSol`
   - `positionSizePct`
   - `maxDeployAmount`
3. Jika wallet tidak dikonfigurasi atau tidak memakai SOL sizing, pakai input
   dari LLM/command.
4. Range BPS dari LLM dibatasi oleh `manager.defaultRangeBps` jika ada.

Pada konfigurasi saat ini:

- `deployAmountSol=0.5`
- `positionSizePct=0.35`
- `maxDeployAmount=50`
- `gasReserve=0.2`
- `minSolToOpen=0.55`
- `defaultRangeBps=400`
- `maxOpenPositions=3`

## 10. Manager Cycle

Sumber: `src/agents/manager.agent.ts` dan
`src/agents/position-evaluator.ts`.

Manager berjalan periodik untuk posisi terbuka:

1. Ambil semua posisi dari `positions.json`.
2. Evaluasi posisi secara paralel.
3. Update `lastEvaluation`.
4. Buat keputusan heuristic.
5. Jika `manager.useLlm=true`, minta LLM manager dan reconcile.
6. Eksekusi action secara serial.
7. Setelah cycle, jalankan learning: collect outcome, mine lessons, emit
   signal weights, emit snapshot.

Evaluator menghitung:

- Current amount X/Y dan fee claimable.
- USD value memakai Jupiter price.
- In-range berdasarkan active bin vs lower/upper bin.
- `inRangePct` dari sample window.
- `outOfRangeMinutes`.
- `pnlUsd`, `pnlPct`, dan IL.
- Jika Meteora PnL API tersedia, angka PnL/IL/fee dioverlay dengan sumber
  resmi.

## 11. Heuristic Manager

Manager memakai heuristic sebagai baseline. Urutan prioritasnya:

1. Trailing take profit fire jika sudah armed dan drop dari peak melewati
   `trailingDropPct`.
2. Arm trailing take profit jika PnL mencapai `trailingTriggerPct`.
3. Simple take profit jika trailing TP disabled dan PnL >= `takeProfitPct`.
4. Stop loss jika PnL <= `stopLossPct`.
5. Close jika IL >= `maxIlUsd`.
6. Close jika out-of-range bins >= `outOfRangeBinsToClose`.
7. Close jika out-of-range terlalu lama dan `inRangePct < 0.4`.
8. Close low-yield jika fee/TVL di bawah minimum setelah umur minimum.
9. Close jika umur posisi melewati `maxPositionAgeMinutes`.
10. Strategy automation:
    - reseed -> close
    - compound -> claim
    - harvest -> claim
11. Claim jika posisi in-range dan fee claimable >= `claimMinUsd`.
12. Default: hold.

Jika manager LLM aktif:

- Critical heuristic close tetap mengalahkan LLM non-close.
- Jika confidence LLM < 0.5, pakai heuristic.
- Jika tidak, pakai keputusan LLM.

Pada konfigurasi saat ini `manager.useLlm=false`, sehingga manager memakai
heuristic deterministic.

## 12. Learning: Decision Recording

Sumber: `src/learning/recorder.ts`.

Setiap keputusan screener dan manager direkam ke
`data/learning-decisions.jsonl` jika learning aktif.

Fitur screener yang direkam:

- `binStep`
- `tvlUsd`
- `activeBinId`
- `feeOverActiveTvl`
- `volumeOverTvl`
- `organicScore`
- `holders`
- `mcUsd`
- `entryPrice`
- `rangeBinsPerSide`
- `pairClass`: `stable`, `major`, `exotic`, atau `unknown`
- `riskFlags`: filter yang gagal

Fitur manager yang direkam:

- Range lower/upper bin.
- In-range metrics.
- Out-of-range minutes.
- PnL, IL, age, claimable fees.
- Pair class dan risk flags operasional.

## 13. Learning: Outcome Scheduler

Sumber: `src/learning/outcome-scheduler.ts`.

Scheduler membaca semua decision dan outcome yang sudah ada. Sebuah outcome
dianggap due jika:

```text
now - decision.timestamp >= horizonMinutes
dan
belum ada outcome untuk decisionId + horizonMinutes
```

Horizon aktif saat ini:

```json
[10, 30, 120, 360]
```

Outcome collector membatasi jumlah yang dilabeli per cycle memakai
`learning.maxOutcomesPerCycle` (saat ini 20).

## 14. Learning: Entry Outcome

Sumber: `src/learning/entry-outcome.ts`.

Untuk keputusan `screener`, outcome bukan realized PnL, melainkan market proxy.
Bot fetch fresh pool pada horizon tertentu dan membandingkan dengan fitur saat
decision dibuat.

Metric yang dihitung:

- `priceReturn`: perubahan harga dari `entryPrice`.
- `feeActiveTvlChange`: perubahan rasio fee/active TVL.
- `volumeTvlChange`: perubahan rasio volume/TVL.
- `activeBinDrift`: jarak active bin sekarang vs active bin saat decision.

Risk flags:

- `tvl_collapsed` jika active TVL <= 0.
- `fee_zero` jika fee window <= 0.
- `active_bin_drifted_out` jika drift melewati batas.
- `fetch_failed` atau `pool_unavailable` jika data tidak bisa diambil.

## 15. Learning: Realized Outcome

Sumber: `src/learning/realized-outcome.ts`.

Untuk keputusan `manager`, outcome memakai data realized jika posisi sudah
closed. Jika belum closed, bot memakai live evaluation.

Prioritas:

1. Closed position dalam window horizon + grace 5 menit.
2. Posisi masih open: evaluasi live.
3. Jika posisi tidak ditemukan: outcome netral dengan risk flag
   `position_missing`.

Metric realized:

- `realizedPnlUsd`
- `realizedFeesUsd`
- `realizedIlUsd`
- `ageMinutes`
- `outOfRangeMinutes`
- `netPnlRiskScore`

## 16. netPnlRiskScore

Sumber: `src/learning/score-net-pnl-risk.ts`.

Score deterministic dalam range `[-1, 1]`.

Jika ada realized PnL:

```text
base = (realizedPnlUsd + realizedFeesUsd - realizedIlUsd - txCostUsd)
       / max(positionSizeUsd, 1)
```

Jika tidak ada realized PnL:

```text
base = priceReturn + 0.5 * feeActiveTvlChange
```

Penalty:

```text
outOfRangePenalty = min(0.3, 0.1 * floor(outOfRangeMinutes / 60))
drawdownPenalty   = min(0.5, 0.5 * drawdownPct)
riskFlagPenalty   = min(0.6, 0.2 * riskFlagsTripped.length)
```

Final:

```text
score = clamp(base - penalties, -1, 1)
```

Interpretasi praktis:

- Score positif: pola keputusan cenderung menguntungkan.
- Score negatif: pola keputusan cenderung merugikan atau berisiko.
- Score mendekati 0: netral, data kurang kuat, atau outcome gagal dihitung.

## 17. Cohort Evidence

Sumber: `src/learning/evidence-index.ts`.

Learning membucket decision dan outcome ke cohort berdasarkan fitur:

```text
pairClass
binStepBand
feeTvlBand
volTvlBand
riskFlagsCount
```

Band:

- `binStepBand`: low < 50, mid 50..125, high > 125.
- `feeTvlBand`: < 0.05, 0.05..0.2, > 0.2.
- `volTvlBand`: < 0.5, 0.5..2, > 2.
- `riskFlagsCount`: 0, 1, atau 2+.

Bobot horizon:

- 10 menit: 0.3
- 30 menit: 0.5
- 120 menit: 0.8
- 360 menit: 1.0

Bobot recency:

```text
recencyWeight = exp(-ageDays / recencyHalfLifeDays)
```

Dengan konfigurasi saat ini, half-life = 14 hari.

`avgScore` cohort adalah rata-rata berbobot dari outcome dalam bucket. Inilah
yang dipakai oleh shadow ranker dan lesson miner.

## 18. ShadowRanker

Sumber: `src/learning/shadow-ranker.ts`.

ShadowRanker adalah observation-only. Ia tidak memblokir trade dan tidak
mengubah config.

Langkah:

1. Rebuild EvidenceIndex.
2. Query bucket yang sesuai dengan fitur decision baru.
3. Jika sample size < `learning.minEvidenceForScore`, tidak mengeluarkan score.
4. Hitung:
   - `expectedScore`: avgScore cohort.
   - `riskScore`: jumlah outcome negatif / sample size.
   - `confidence`: naik sesuai sample size, capped di 1.
5. Tulis ke `data/shadow-scores.jsonl`.

Disagreement saat ini:

- LLM `ENTER` tapi `expectedScore < -0.1` -> shadow recommends `avoid`.
- LLM `SKIP` tapi `expectedScore > 0.2` -> shadow recommends `favor`.

Disagreement dicatat ke decision journal sebagai `SHADOW_DISAGREEMENT`, tetapi
tidak menjadi veto.

## 19. Lesson Miner

Sumber: `src/learning/lesson-miner.ts`.

Lesson miner membuat lesson dari dua sumber:

1. Cohort evidence:
   - sample size >= `minCohortSamples`
   - `abs(avgScore) >= minCohortAbsAvg`
   - rule berbentuk `favor cohort [...]` atau `avoid cohort [...]`
2. Closed position:
   - score dihitung dari realized PnL/fee/IL.
   - rule berbentuk `favor:` atau `avoid:` berdasarkan hasil close.

Dedup:

- Normalized rule yang sama dianggap duplicate.
- Tag overlap Jaccard >= 0.7 dengan prefix rule sama juga dianggap duplicate.

Lesson ditulis ke learning lessons store dan bisa masuk prompt melalui
MemoryRouter.

## 20. Signal Weights

Sumber: `src/learning/signal-weights.ts`.

Signal weights menghitung historical lift untuk fitur numerik dan kategorikal.
Ini juga observation-only.

Untuk fitur numerik, bot membagi sample menjadi:

- `withSignal`: nilai >= median.
- `withoutSignal`: nilai < median.

Lift:

```text
lift = avgScore(withSignal) - avgScore(withoutSignal)
```

Signal positif/negatif teratas ditulis ke `data/signal-weights.json` dan
dimasukkan ke prompt screener sebagai weak hint, bukan hard rule.

## 21. Memory Router

Sumber: `src/memory/memory-router.ts`.

MemoryRouter menyusun konteks prompt dari:

- Recent decision journal.
- Lessons dari manager lessons file.
- Learning lessons.
- Shadow disagreement evidence.

Relevance dihitung berdasarkan:

- Sama position pubkey.
- Sama pool address.
- Sama pool name.
- Overlap simbol token.
- Recency bonus.

Memory bisa disisipkan ke screener, manager, dan post-mortem sesuai config.

## 22. Rancangan Shadow-Test LLM vs Rule-Based

Tujuan eksperimen: membandingkan apakah keputusan LLM lebih baik daripada rule
deterministic tanpa mengubah perilaku live bot.

### Unit Analisis

Satu baris decision screener di `learning-decisions.jsonl`.

### Label Ground Truth

Gunakan `learning-outcomes.jsonl`:

- Positive jika `netPnlRiskScore > 0.05`.
- Neutral jika `-0.05 <= netPnlRiskScore <= 0.05`.
- Negative jika `netPnlRiskScore < -0.05`.

Untuk trade live/paper yang benar-benar dibuka, realized outcome lebih kuat
daripada entry market proxy.

### Arm A: LLM

Ambil keputusan asli:

- `ENTER`
- `WATCH`
- `SKIP`
- confidence
- risks count
- deployGate status

Hipotesis:

- LLM bagus jika `ENTER` sering berakhir positive.
- LLM terlalu konservatif jika banyak `SKIP` pada cohort yang kemudian positive.

### Arm B: Rule-Based Screener

Gunakan ulang skor deterministic:

```text
ruleScore =
  feeActiveTvlRatioPct * 100
  + volumeTvlRatioPct * 20
  + swaps * 5
  + liquidityAdds * 3
  + volumeSpikes * 2
  - liquidityRemoves * 8
  - riskCount * 2
```

Rule-based pseudo action:

- `RULE_ENTER`: filters passed, entryPolicy passed, collapseGuard passed, dan
  masuk top `maxDeploysPerCycle`.
- `RULE_SKIP`: selain itu.

Threshold tambahan bisa diuji offline, misalnya:

- `ruleScore >= p75` dari score harian.
- `feeActiveTvlRatioPct >= threshold`.
- `swaps >= minSwaps`.
- `liquidityRemoves <= liquidityAdds + maxRemoveMinusAdd`.

### Arm C: Cohort Shadow

Gunakan `shadow-scores.jsonl`:

- `SHADOW_ENTER/FAVOR` jika `expectedScore > 0.2`.
- `SHADOW_AVOID` jika `expectedScore < -0.1`.
- `SHADOW_NEUTRAL` jika sample kurang atau score di tengah.

### Metric Eksperimen

Metric utama:

- Precision ENTER: persentase ENTER yang outcome positive.
- False ENTER: persentase ENTER yang outcome negative.
- Opportunity loss: SKIP yang outcome positive.
- Avoid success: shadow/rule avoid yang outcome negative.
- Avg `netPnlRiskScore` per arm.
- Disagreement rate: LLM vs rule, LLM vs shadow.
- Cost per useful ENTER: jumlah LLM call / positive ENTER.

Metric risiko:

- Persentase ENTER yang kena `tvl_collapsed`, `fee_zero`,
  `active_bin_drifted_out`.
- ENTER yang diblokir collapseGuard dan outcome setelahnya.
- ENTER yang diblokir fresh validation dan outcome setelahnya.

### Matrix Keputusan

```text
LLM ENTER + Rule ENTER + Shadow favor
  -> kandidat paling kuat.

LLM ENTER + Rule ENTER + Shadow avoid
  -> cek cohort evidence; kandidat rawan false positive.

LLM ENTER + Rule SKIP
  -> LLM melihat sesuatu yang rule tidak tangkap; perlu audit reasons.

LLM SKIP + Rule ENTER + Shadow favor
  -> opportunity loss kandidat.

LLM SKIP + Rule SKIP + Shadow avoid
  -> skip kuat.
```

### Output Eksperimen Yang Diinginkan

Minimal satu tabel per horizon:

```text
horizon | arm | enter_count | positive_pct | negative_pct | avg_score
10m     | LLM | ...
10m     | RULE | ...
10m     | SHADOW | ...
30m     | LLM | ...
120m    | LLM | ...
360m    | LLM | ...
```

Dan satu tabel disagreement:

```text
horizon | disagreement_type | count | avg_score | notes
360m    | LLM_ENTER_SHADOW_AVOID | ...
360m    | LLM_SKIP_SHADOW_FAVOR | ...
360m    | LLM_ENTER_RULE_SKIP | ...
```

### Prinsip Eksperimen

- Jangan ubah execution live saat eksperimen.
- Gunakan append-only data yang sudah ada.
- Jalankan minimal sampai horizon 360 menit terpenuhi agar outcome panjang
  tersedia.
- Bandingkan per cohort, bukan hanya agregat global.
- Jangan langsung menjadikan shadow/rule sebagai veto sebelum sample cukup.

## 23. Catatan Risiko Logika Saat Ini

- `learning.mode=active` dan `dryRun=false` berarti bot bisa live execution
  sesuai konfigurasi saat ini.
- `entryPolicy.requireRecentActivity` hanya berguna jika realtime listener
  berjalan; tanpa listener, recent event kosong.
- OKX risk data yang tidak tersedia bisa lolos hard filter, tetapi akan diblok
  oleh collapseGuard jika `requireRiskDataForEnter=true`.
- ShadowRanker belum menjadi pengambil keputusan; ia hanya mencatat
  disagreement.
- Learning tidak otomatis mengubah threshold atau config.
- LLM confidence sangat dominan pada ranking deploy ENTER.
- Fresh validation adalah pengaman terakhir sebelum open; ini penting karena
  token mikro bisa berubah drastis setelah LLM mengambil keputusan.

## 24. File Logika Utama

- `src/agents/realtime.listener.ts`
- `src/agents/screener.agent.ts`
- `src/utils/entry-policy.ts`
- `src/agents/manager.agent.ts`
- `src/agents/position-evaluator.ts`
- `src/learning/recorder.ts`
- `src/learning/outcome-scheduler.ts`
- `src/learning/entry-outcome.ts`
- `src/learning/realized-outcome.ts`
- `src/learning/score-net-pnl-risk.ts`
- `src/learning/evidence-index.ts`
- `src/learning/shadow-ranker.ts`
- `src/learning/lesson-miner.ts`
- `src/learning/signal-weights.ts`
- `src/memory/memory-router.ts`
