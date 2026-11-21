## Why

The intents brain understands only the phrasings in its pattern table. Paraphrases ("could you head back to base", "keep the creepers away from me", "i could use some bread") fall through to the cloud LLM (a paid turn) or, while the LLM is down, get "didn't get that". The owner wants understanding to be a set of interchangeable layers (patterns, a local embedding model, a local LLM, the cloud LLM) that can be mixed, reordered, switched off, tuned and benchmarked.

## What Changes

- An `IntentLayer` interface and an `IntentPipeline` with three strategies: `first_confident`, `vote`, `best`. Each layer has its own threshold; one decision-log line per message.
- Layers: `patterns` (the existing parser, synchronous), `embeddings` (transformers.js with `Xenova/all-MiniLM-L6-v2` q8 on the CPU, nearest labelled examples by k-NN or centroid, threshold plus margin, lazy load, disk cache in `data/models/`, "unavailable" when it can't load), `local_llm` (any OpenAI-compatible endpoint, strict JSON, short timeout, output validated against the intent list and the line), `cloud_llm` (the existing handoff to the LLM brain, as the last step).
- Slots for intent-only layers come from the parser's extractors (`slots.ts`), never from a model; model-supplied values must be grounded in the line and name real items.
- Profile `intents.layers` / `strategy` / `log_decisions` / `min_votes` / `examples`; live toggles `intents.strategy`, `intents.log_decisions`, `intents.layers.<name>.enabled` and `.threshold`. Default stays patterns then the cloud LLM. Pax: patterns + embeddings, `first_confident`.
- `LlmRuntime.handoff(msg)`: a claimed line given back when the slower layers didn't understand it.
- `scripts/intents-bench.ts` / `just intents-bench`: accuracy, macro-F1, false triggers, slot accuracy, latency and load time per config, on the parser's 137 phrasings and 107 held-out paraphrases; `--grid` for thresholds.
- `@huggingface/transformers` as an optional dependency.

## Impact

- Code: `src/brains/intents/` (pipeline.ts, config.ts, slots.ts, examples.ts, layers/, brain.ts, parse.ts), `src/llm/runtime.ts`, `src/core/profile.ts`, `src/core/toggles.ts`, `profiles/pax.yaml`, `scripts/intents-bench.ts`, `justfile`, `package.json`.
- Tests: `test/intents-layers.test.ts`, `test/intents-brain.test.ts`, `test/fixtures/`.
- Docs: `docs/guide/intents.md`, `docs/guide/live-config.md`.
