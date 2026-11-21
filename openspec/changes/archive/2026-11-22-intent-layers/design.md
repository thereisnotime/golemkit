## Context

The intents brain decided synchronously inside the chat listener: it runs first (prependListener) and marks lines it takes with `msg.claimedBy`, so the LLM runtime and the command brain skip them. Embedding and LLM layers are asynchronous, which breaks "decide before the next listener runs".

## Decisions

- **Claim first, give back later.** Synchronous layers (patterns) run inside the listener. If a confident answer comes from them under `first_confident`, nothing changes. If an async layer still has to run, the line is claimed right away and classified in the background; if no layer is confident and the LLM can think, the line is handed back through `LlmRuntime.handoff(msg)` (the same routing as an unclaimed line, minus the memory push it already got). Exactly one handler either way.
- **Newer commands win.** Each addressed line gets a sequence number per speaker; an async guess that finishes after a newer line from the same speaker was acted on is dropped ("follow me" then "stop" never ends with following).
- **cloud_llm is not a classifier.** It is the handoff, always last. It is on unless switched off (`enabled: false` or the toggle); off means unclear lines in mode `first` are dropped instead of costing a turn.
- **Settings shape.** Profiles write `layers` as an ordered list; it lands in settings as `{ layers: {name: entry}, order: [names] }` so dotted live toggles (`intents.layers.embeddings.threshold`) merge into it with the existing deep merge (an array would be replaced wholesale).
- **Slots from the line.** Embeddings and the local LLM only pick the intent. `extractSlots()` reuses the parser's helpers (leadingCount, normalizeItem, ACTIVITIES, TEMPLATES) to fill args, refines the intent (goto home -> go_home, "stop chopping" -> behavior_off, "your bread" -> give) and reports a missing required slot, which rejects the guess. Model-supplied args are kept only if grounded in the line (numbers said, item words present and a real 1.21.1 item, place words present).
- **Shape checks for loose layers.** Negations, questions (confidence halved, as for patterns), statements ("I'm going to get wood", "can anyone ...") and lines that start by naming someone else are rejected by the embeddings and local LLM layers.
- **Margin within families.** The embeddings margin is measured against the best intent outside the winner's family (follow/unfollow, guard/unguard, behavior_on/off, bring/give); the words settle those pairs better than sentence embeddings, which are weak on polarity.
- **Optional dependency.** `@huggingface/transformers` is an optionalDependency loaded by dynamic import; if it or the model can't load, the layer is "unavailable", logged once and skipped.
- **Layer cache.** Pipelines are rebuilt when the config changes (thresholds are pipeline-level), layer instances are cached by their config, and the transformers.js pipeline is cached per model, so a live threshold change doesn't reload the model.

## Risks / Trade-offs

- The held-out set was also used for the threshold grid and to spot generic gaps (polarity, statements, tool words), so its numbers are optimistic; the defaults stay at the conservative 0.62/0.05, Pax uses the tuned 0.58/0.03.
- The package is large on disk (onnxruntime-node ships binaries for every platform, ~470 MB with onnxruntime-web and sharp), hence optional.
- An async layer delays the LLM by its latency on lines it doesn't understand (a few ms for embeddings, up to the timeout for a local LLM).
