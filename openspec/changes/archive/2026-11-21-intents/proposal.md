## Why

When the LLM is down (subscription quota used up, budget out, provider missing, or a variant with no LLM at all) owners can only drive the bot with `!commands`. Plain requests like "pax follow me" or "chop some wood" then get a "thinking break" notice or nothing. Simple requests also cost a full LLM turn each when the LLM is up.

## What Changes

- New pure parser `src/brains/intents/parse.ts`: text to `{ intent, args, confidence }` with synonyms, number words, vague amounts ("a stack" = 64, "a few" = 3), item normalisation and "me/here/there" resolution. No eval, no code execution.
- New `intentsBrain()`: owner chat only, addressed by name/alias at the start or end, by whisper, alone with the owner or in a recent exchange. Maps intents to actions through `agent.act()` at player priority, or arms/disarms behaviours (`bodyguard`, falling back to `guard_owner`). Uses `find_target` and `bring_item` when they exist and says so truthfully when they don't. Status and help answered from `observe()`.
- `intents.mode` (profile, live toggle): `fallback` (default, only while the LLM can't think), `first` (simple requests itself, the rest to the LLM), `off`. Pax uses `first`.
- Small core hooks: `ChatMessage.claimedBy`, `TypedEmitter.prependListener`, `LlmRuntime.blockedReason()`, and claimed messages are skipped by the LLM runtime and the command brain.

## Impact

- Code: `src/brains/intents/`, `src/core/agent.ts`, `src/core/events.ts`, `src/core/toggles.ts`, `src/core/profile.ts`, `src/llm/runtime.ts`, `src/brains/command.ts`, `variants/companion.ts`, `variants/buddy.ts`, `profiles/pax.yaml`.
- Docs: `docs/guide/intents.md`.
