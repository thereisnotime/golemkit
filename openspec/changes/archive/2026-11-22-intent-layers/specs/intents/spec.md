## ADDED Requirements

### Requirement: Layered intent pipeline
Command understanding SHALL be an ordered pipeline of classifier layers (patterns, embeddings, local_llm), each optional with its own threshold, followed by the cloud LLM handoff. The strategy SHALL be first_confident (the first layer at or above its threshold wins), vote (the intent most confident layers agree on) or best (the highest confidence). A rejected guess or a failing layer SHALL never win.

#### Scenario: First confident layer wins
- **WHEN** the strategy is first_confident and patterns miss "keep the creepers away from me" but embeddings guess guard above their threshold
- **THEN** the winner is the embeddings guess and later layers do not run

#### Scenario: Vote
- **WHEN** the strategy is vote and two confident layers say follow while one says guard
- **THEN** the winner is follow, with the args of the more confident follow guess

#### Scenario: Default pipeline
- **WHEN** a profile configures no layers
- **THEN** the pipeline is patterns at the intents threshold (0.7) followed by the cloud LLM handoff, as before

### Requirement: One handler per message with asynchronous layers
When a slower layer has to run, the intents brain SHALL claim the line before the next chat listener runs and, if no layer is confident and the LLM can think, SHALL hand it back to the LLM brain exactly once. A guess that finishes after a newer command from the same speaker was acted on SHALL be dropped.

#### Scenario: Not understood
- **WHEN** an owner says "pax tell me a joke about creepers" in mode first with an embeddings layer
- **THEN** the line is claimed at once, no layer is confident, and the LLM runs exactly one turn for it

#### Scenario: Newer command first
- **WHEN** a line waits for the embeddings layer and the owner says "stop" before it answers
- **THEN** only stop is acted on

#### Scenario: Handoff off
- **WHEN** intents.layers.cloud_llm.enabled is false and no layer understands a line in mode first
- **THEN** the line is claimed and the LLM does not run

### Requirement: Embeddings layer
The embeddings layer SHALL classify by cosine similarity to labelled example phrasings (k-NN or centroid) with a threshold and a margin to the best rival outside the intent's family, SHALL take slots from the line with the parser's extractors, SHALL load its model on first use and cache it under data/models, and SHALL report unavailable (logged once, skipped by the pipeline) when the package or model can't load.

#### Scenario: Paraphrase with slots
- **WHEN** the line is "dig up twenty sand"
- **THEN** the intent is collect with item sand and count 20

#### Scenario: Chat
- **WHEN** the line is closest to the none examples or is a statement such as "I'm going to get some wood"
- **THEN** the guess is rejected

#### Scenario: Package missing
- **WHEN** @huggingface/transformers is not installed
- **THEN** the layer is unavailable, one warning is logged, and the remaining layers decide

### Requirement: Local LLM layer
The local_llm layer SHALL ask an OpenAI-compatible endpoint for strict JSON {intent, args, confidence} with a configurable timeout (default 2 s), SHALL only accept known intents, and SHALL reject a guess whose items, counts, places, players or coordinates are not grounded in the line or are not real items. Model output SHALL never be evaluated.

#### Scenario: Invented item
- **WHEN** the line is "bring me bread" and the model answers bring with item diamond_sword
- **THEN** the guess is rejected

#### Scenario: Timeout and unreachable endpoint
- **WHEN** the endpoint does not answer within the timeout, or can't be reached
- **THEN** the layer yields nothing for that line, and an unreachable endpoint is skipped for a while (logged once)

### Requirement: Pipeline configuration and live toggles
The profile SHALL configure intents.layers (ordered), strategy, min_votes, log_decisions and extra examples. Live toggles SHALL switch intents.strategy, intents.log_decisions and each known layer's enabled and threshold without a restart, and SHALL not reload a loaded model when only a threshold changes.

#### Scenario: Threshold toggle
- **WHEN** an owner runs "!config_set intents.layers.embeddings.threshold 0.55"
- **THEN** the next line uses 0.55 with the already loaded model

#### Scenario: Enable by toggle
- **WHEN** a bot without layer config gets "!config_set intents.layers.embeddings.enabled on"
- **THEN** the embeddings layer runs after patterns and before the handoff

### Requirement: Benchmark
scripts/intents-bench.ts SHALL run any set of layer configs over labelled sets (the parser's phrasings, a held-out paraphrase set not in the examples, or a JSON file) and report accuracy, macro-F1, false triggers on must-not-trigger lines, slot accuracy, latency p50/p95 and model load time as a table and JSON, with an optional threshold grid.

#### Scenario: Side-by-side configs
- **WHEN** it runs with "--config patterns --config patterns+embeddings --set heldout"
- **THEN** it prints one row per config and set with those metrics
