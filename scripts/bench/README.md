# Archive writer benchmark

Run `benchArchiveWrites.mjs` with the absolute public repository's `plugins` directory. It uses installed dependencies and disposable databases. It never starts or stops the app or opens its archive. `WRITE_BENCH_HOST` optionally selects an absolute baseline host checkout; unset it to measure the current checkout.

The mixed fixture inserts 20,000 messages, 8,000 attachments and 3,200 link shares over 390 days. Attachments, Links and Analytics install their real rollups. Timed writes use a native archive connection, as Core does, without the plugin database facade. Three runs compare no rollup triggers, each trigger family alone, and all triggers. Metadata triggers have no timed entity writes in this fixture; their samples are a noise control. Span triggers run against an empty run history, so this fixture measures their fixed per-message cost rather than overlap searches against existing runs.

The re-fetch fixture ingests 1,000 messages with preview text, then re-ingests unchanged payloads in one writer transaction. It records count-statement preparations, executions and their separate elapsed time. Callbacks are no-ops, isolating archive ingestion from downstream rule work.

Each timed writer operation is synchronous and uninterrupted on Core. Its duration is therefore its blocking turn. The summary reports median ingest time and the longest observed blocking turn. This deliberately exposes large caller batches; it does not imply a scheduling yield inside an atomic write. Shared dirty-mark expansion runs later, with a yield after each bounded batch.

JSON lines retain every sample, process CPU time and SQLite `total_changes()` deltas, including trigger writes. Compare runs on the same machine without overlapping test suites. Disk cache, other processes and fixture setup can affect absolute wall time. Preparation/execution counts, row-change counts and coalesced dirty-mark contracts provide deterministic verification alongside timings.

## Recorded result: 2026-10-19

`archiveWriteResults.json` retains the source commits and every native-writer sample. Bulk median: **4,308.49 → 3,799.63 ms**; process CPU: **4,282 → 3,781 ms**. The no-trigger controls were 2,264.89 / 2,993.15 ms wall and 2,234 / 2,703 ms CPU. Incremental all-trigger CPU above those controls fell from 2,048 to 1,078 ms. Partition invalidation alone fell from 1,001 to 220 ms above its CPU control, and from 105,920 to 858 additional SQLite row changes.

The longest all-trigger turn was **4,395.08 → 4,804.14 ms**. This noisy run does not establish a longest-turn improvement; large atomic batches still block Core for their full duration. Baseline family CPU deltas were approximately partition 1,001 ms, reference 875 ms, span 313 ms; metadata had no timed entity writes. These deltas are attribution samples, not additive estimates; external machine load was not controlled.

Unchanged re-fetch median: **2,021.43 → 1,919.17 ms**; CPU **2,172 → 1,796 ms**. Count preparations fell **2,000 → 1**, with 2,000 executions retained. Median preparation time fell **431.96 → 0.42 ms**; execution time was **78.77 → 61.37 ms**. The longest re-fetch turn was **2,433.14 → 2,501.83 ms**, also not improved in this run. The separate notification contract verifies that 1,000 trigger-covered changes issue zero writer queries.
