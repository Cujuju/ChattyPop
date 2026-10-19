# Archive writer benchmark

Run `benchArchiveWrites.mjs` with the absolute public repository's `plugins` directory. It uses installed dependencies and disposable databases. It never starts or stops the app or opens its archive. `WRITE_BENCH_HOST` optionally selects an absolute baseline host checkout; unset it to measure the current checkout.

The mixed fixture inserts 20,000 messages, 8,000 attachments and 3,200 link shares over 390 days. Attachments, Links and Analytics install their real rollups. Three runs compare no rollup triggers, each trigger family alone, and all triggers. Metadata triggers have no timed entity writes in this fixture; their samples are a noise control. Span triggers run against an empty run history, so this fixture measures their fixed per-message cost rather than overlap searches against existing runs.

The re-fetch fixture ingests 1,000 messages with preview text, then re-ingests unchanged payloads in one writer transaction. It records count-statement preparations, executions and their separate elapsed time. Callbacks are no-ops, isolating archive ingestion from downstream rule work.

Each timed writer operation is synchronous and uninterrupted on Core. Its duration is therefore its blocking turn. The summary reports median ingest time and the longest observed blocking turn. This deliberately exposes large caller batches; it does not imply a scheduling yield inside an atomic write. Shared dirty-mark expansion runs later, with a yield after each bounded batch.

JSON lines retain every sample. Compare runs on the same machine without overlapping test suites. Disk cache, other processes and fixture setup can affect absolute wall time. Preparation/execution counts and coalesced dirty-mark contracts provide deterministic verification alongside timings.
