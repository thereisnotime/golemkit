## Context

Several brains listen to the same `chat` event: the command brain (`!` prefix and plain whispers), the LLM runtime (mentions, conversations, alone with the owner) and now intents. A message must reach exactly one of intents and the LLM.

## Decisions

- **Claiming.** `ChatMessage` gets an optional `claimedBy`. The intents brain registers its listener with `prependListener`, so it runs before every other brain whatever their order in the variant, decides synchronously and sets `claimedBy = 'intents'`. `LlmRuntime.onChat` still records the line in memory (context for later turns) and returns; the command brain returns too (a plain whisper "follow me" would otherwise run `!follow me`). The parse is synchronous and pure, so there is no race.
- **LLM availability.** `LlmRuntime.blockedReason()` returns why a turn can't run now (provider check failed, budget blocked, provider quota until a time) or null. No LLM brain counts as down. Read at message time, so quota pauses and budget resets apply immediately.
- **Modes.** `fallback`: claim only while the LLM is down. `first`: claim confident intents always, the rest goes to the LLM; while the LLM is down this behaves like fallback. `off`: never claim. Read from `settings.intents.mode` on every message, so `!config_set intents.mode off` is live.
- **Parsing.** Ordered table of anchored regular expressions over a cleaned line (lower case, punctuation, shorthand, polite lead-ins and trailing fillers stripped). A rule must match the whole line, so chat that merely contains "follow me" doesn't trigger. Questions (trailing `?` without a polite "can you", or starting with did/do/is/why/how...) halve the confidence of non-info intents, which puts them under the 0.7 threshold. Negations other than "don't follow me" give nothing.
- **Addressing.** Name or alias at the start ("pax, ...", "@pax ...", "hey pax ...") or end ("... pax"); a name in the middle doesn't count. Whispers, alone with the owner (same rule as the runtime, off with `listen: mention`), and follow-ups within `llm.conversationMs` after an intents reply.
- **Acting.** Everything goes through `agent.act()` with `caller: { kind: 'player', name }` and `PRIORITY.player`, so the action lock, preemption and the LLM's goal handling ("stop" by a player drops the goal) behave as for `!commands`. Behaviour changes go through `behavior_arm` / `behavior_disarm`, so the owner check and persistence stay in one place. Slow actions get an "on it" after 1.5 s and the real outcome when they end; interrupted ones (stopped, preempted) are not reported.
- **Missing pieces.** `find_target`, `bring_item` and `bodyguard` are resolved at runtime (`agent.getAction`, the behaviour registry). Missing: a truthful reply ("find_target isn't available here yet"); "guard me" falls back to `guard_owner`, then the `guard` action; "bring" falls back to walking over and dropping it when the bot carries the item.

## Risks and trade-offs

- Regex rules miss unusual phrasings; in `first` mode those go to the LLM, in `fallback` the owner gets a short "didn't get that, say pax help".
- In `first` mode a confident but wrong parse doesn't reach the LLM. The table keeps rules anchored and conservative, and a broad unit table includes chat that must not trigger.
