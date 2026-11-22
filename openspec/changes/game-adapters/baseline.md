# Baseline and parity results

Recorded on branch `feat/game-adapters`, starting from `main` at d83e695 (v0.1.0). Every phase
ends with the checks from [tasks.md](tasks.md#parity-checks-after-every-phase); this file keeps
the numbers.

## How to run the checks

| check | command | what "same" means |
|---|---|---|
| tsc, unit tests, golden snapshots, packet replay, intents bench | `just parity` (`node scripts/parity.ts`) | tsc clean; tests all pass, same count or more; golden files identical; replay identical; intents bench identical to `bench/intents-baseline.json` (timings ignored) |
| live smoke test | `node --env-file=.env scripts/smoke-test.ts --tag <phase>` | the same ok/fail per step |
| guard bench | `node --env-file=.env scripts/guard-bench.ts --phases guard --repeats 3 --minutes 3 --waves mixed --tag <phase>` | tester hits and damage within run-to-run variance |
| scope | `just scope-check`, `node scripts/adapter-lint.ts --warn` | informational |

The golden snapshots live in `test/fixtures/golden/` (`observe.json`: two fake worlds and a
disconnected agent, with the golden variant and with companion; `action-catalogs.json`: every
variant's and profile's actions, catalog and `!help` line; `llm-tools.json`: the LLM tool list
for companion and pax; `intent-decisions.json`: the patterns layer on the seen and held-out sets;
`replay-events.json`: the replayed session's events, parsed packet counts, registry sizes and
final observe()). The packet recording is `test/fixtures/replay/session.json.gz` (3.6 MB): a
30 s session of the test account GuardTester at the smoke-test spot, recorded with
`scripts/replay-record.ts` while ClaudeTest said one public line and one whisper.

Live tests run 300+ blocks from spawn, the fortress, the village and the owner (offline every
time): the smoke test in a spruce forest at 1250 -300, the guard bench at its default arena
1250 445. Bot GuardTest, tester GuardTester, op director ClaudeTest.

## Phase 0: baseline

| check | result |
|---|---|
| tsc | clean |
| unit tests | 680 tests (675 before phase 0 plus 5 new: 4 golden, 1 replay), 679 pass, 0 fail, 1 skipped |
| golden snapshots | 5 files written |
| packet replay | handshake 4221 bytes out, identical; 992 chunks, 3.7 MB in; 57 packet kinds parsed |
| intents bench | patterns seen 1.000 / held-out 0.495; embeddings 0.905 / 0.729; patterns+embeddings 1.000 / 0.766 (0 false triggers anywhere) |
| docs build | ok (`just docs-build`) |
| scope-check | 23 files import Minecraft packages outside src/skills, src/core/neoforge and scripts |
| adapter-lint (phase 1 rule, run on the baseline) | 407 violations in 40 files |

Scope-check counts at the baseline (import / bot use / either of files):

| directory | files | import | bot use | either |
|---|---|---|---|---|
| src/core/ (top level) | 19 | 9 | 4 | 9 |
| src/core/journal/ | 13 | 1 | 2 | 2 |
| src/core/neoforge/ | 5 | 2 | 0 | 2 |
| src/llm/ | 25 | 0 | 2 | 2 |
| src/context/ | 6 | 0 | 0 | 0 |
| src/brains/ (top level) | 5 | 0 | 3 | 3 |
| src/brains/behaviors/ | 19 | 8 | 10 | 10 |
| src/brains/intents/ | 10 | 0 | 1 | 1 |
| src/brains/npc/ | 13 | 3 | 5 | 6 |
| src/brains/scene/ | 10 | 0 | 2 | 2 |
| src/brains/self/ | 9 | 2 | 2 | 2 |
| src/skills/ | 49 | 27 | 34 | 35 |
| scripts/ | 25 | 0 | 13 | 13 |
| variants/ | 5 | 0 | 0 | 0 |

### Live smoke test (phase 0)

| step | result | note |
|---|---|---|
| connect | ok | |
| follow | ok | 2.5 blocks from the tester after it walked 10 blocks |
| chop | ok | 8 spruce logs |
| find_iron | ok | iron ore in sight |
| bring_planks | FAIL | crafted 4 planks and tossed them, but the tester (no brain) never picked them up; the script now has the tester run pickup_items while the bot brings, see the rerun below |
| go_home | ok | |
