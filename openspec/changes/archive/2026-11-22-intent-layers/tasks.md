## 1. Pipeline
- [x] 1.1 IntentLayer interface, IntentPipeline with first_confident / vote / best, decideSync, decision log line
- [x] 1.2 patterns layer wrapping parseIntent
- [x] 1.3 Config resolution (profile list -> named entries + order, toggles, defaults) and pipeline building with a layer cache

## 2. Layers
- [x] 2.1 Reusable slot extraction and model-output validation (slots.ts), parser refactor (lineShape, shapeConfidence, resolvePlayers)
- [x] 2.2 Labelled examples (examples.ts) with a none class; profile examples merged in
- [x] 2.3 embeddings layer: transformers.js, knn/centroid, threshold + margin, lazy load, data/models cache, unavailable handling
- [x] 2.4 local_llm layer: OpenAI-compatible, strict JSON, timeout, validation, skip when unreachable

## 3. Brain and core
- [x] 3.1 Brain uses the pipeline; claim-then-handoff for async layers; stale guesses dropped; decisions logged
- [x] 3.2 LlmRuntime.handoff()
- [x] 3.3 Profile schema (intents.layers, strategy, min_votes, log_decisions, examples) and toggles
- [x] 3.4 Pax: patterns + embeddings, first_confident

## 4. Benchmark
- [x] 4.1 scripts/intents-bench.ts (accuracy, macro-F1, false triggers, slots, latency, load, JSON, --grid) and just intents-bench
- [x] 4.2 Held-out paraphrase set (107 lines, 22 must-not-trigger), checked not to overlap the examples
- [x] 4.3 Real runs: patterns, embeddings, patterns+embeddings, and a local LLM (llama.cpp in podman)

## 5. Tests and docs
- [x] 5.1 Pipeline strategies, embeddings with a fake embedder, local_llm with a fake HTTP server, config, bench, brain integration, opt-in real-model test
- [x] 5.2 docs/guide/intents.md (pipeline, config, strategies, diagram, numbers, bench), docs/guide/live-config.md
