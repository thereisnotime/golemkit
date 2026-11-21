## 1. Parser
- [x] 1.1 Cleaning, addressing, numbers, item normalisation in src/brains/intents/parse.ts
- [x] 1.2 Rule table for all intents, question and negation handling, confidence
- [x] 1.3 Table-driven unit tests (80+ phrasings, including ones that must not trigger)

## 2. Brain
- [x] 2.1 intentsBrain(): owners only, addressing, modes, claim
- [x] 2.2 Intent to action / behaviour mapping with truthful replies; runtime lookup of find_target, bring_item, bodyguard
- [x] 2.3 Status from observe(), help
- [x] 2.4 Brain tests with a fake agent: owner vs non-owner, modes, exactly one handler

## 3. Core and config
- [x] 3.1 ChatMessage.claimedBy, TypedEmitter.prependListener, LlmRuntime.blockedReason(), claimed lines skipped by the runtime and the command brain
- [x] 3.2 intents.mode toggle, profile key, Pax on first, companion and buddy variants

## 4. Docs and verification
- [x] 4.1 docs/guide/intents.md with phrase table, modes and flow diagram; sidebar
- [x] 4.2 tsc, unit tests, live check on mc02 with no LLM
