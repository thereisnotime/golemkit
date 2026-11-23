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

### Guard bench (phase 0)

`--phases guard --repeats 3 --minutes 3 --waves mixed`, seed 1, day, iron sword, no armour. Raw
results: [bench/guard-phase0.jsonl](bench/guard-phase0.jsonl).

| run | summoned | tester hits | damage | tester deaths | bot deaths | bot hits | kills |
|---|---|---|---|---|---|---|---|
| 1 | 27 | 35 | 114 | 3 | 3 | 40 | 18 |
| 2 | 27 | 35 | 112 | 3 | 3 | 21 | 12 |
| 3 | 27 | 27 | 78 | 2 | 1 | 13 | 17 |
| mean | 27 | 32.3 ± 4.6 | 101 ± 20 | 2.7 | 2.3 | 24.7 | 15.7 |

Arena clean-up before the runs (`guard-bench.ts --cleanup`): killed 4 leftover tagged mobs and
15 dropped items, filled 39 blocks of creeper holes, cleared both inventories and effects.
GuardTester died to something in the arena during the clean-up, before the kill command landed.

## Live smoke test, every phase

The script changed twice during phase 0 (the bot had no reflexes in a dark forest and died; then
the tester never picked the planks up). The final script gives both players Resistance, removes
natural hostiles around the spot and has the tester pick up drops, and counts bring_planks as ok
when the tester ends up with the planks. All runs below use the final script, from snapshots of
the code at each phase.

| step | phase 0 | phase 1 | phase 2 | phase 3 |
|---|---|---|---|---|
| connect | ok | ok | ok | ok |
| follow | ok (1.4) | ok (1.7) | ok (1.8) | ok (1.8) |
| chop | ok (6 logs) | FAIL (tree at 1258 97 -290 out of reach) | ok (30 logs, climbed 24) | ok (8 logs) |
| find_iron | ok | ok | ok | ok |
| bring_planks | ok | ok | ok | ok |
| go_home | ok | ok | ok | ok |

Phase 1 added only interfaces and a lint script (no code path changed), so its chop failure is
the world: earlier runs had cleared the nearest trees and the next one stood on a slope it
couldn't path to; the following runs went to other trees. Earlier phase 2 run with the previous
script: all ok as well.

## Phase 1: interfaces and lint (warning)

| check | before | after |
|---|---|---|
| tsc | clean | clean |
| unit tests | 680 / 679 pass | 680 / 679 pass |
| golden snapshots | | identical |
| packet replay | | identical |
| intents bench | | identical |
| smoke test | | see the table above |
| adapter-lint (warning) | | 407 violations in 40 files: the phase 2 work list |

## Phase 2: Minecraft Java behind the interface

| check | before | after |
|---|---|---|
| tsc | clean | clean |
| unit tests | 680 / 679 pass | 685 / 684 pass (5 new adapter tests) |
| golden snapshots | | identical |
| packet replay | | identical (handshake bytes and events) |
| intents bench | | identical |
| smoke test | | same results (all ok) |
| adapter-lint (warning) | 407 | 0 |
| scope-check: Minecraft imports outside the expected places | 23 | 0 |

Test plumbing that changed (not the goldens): `test/fake-attach.ts` puts the fake bot behind the
adapter instead of `agent._bot`; fake agents in the npc, behaviours, self and go-home tests get
`adapter: minecraftView(bot)` (the real adapter over their fake bot), the intents-brain fake
agent an equivalent view, and `dig-refusal` imports `watchRefusedDigs` from its new place.

## Phase 3: capabilities and lint as an error

| check | before | after |
|---|---|---|
| tsc | clean | clean |
| unit tests | 685 / 684 pass | 689 / 688 pass (4 new capability tests) |
| golden snapshots | | identical (the Minecraft adapter supports every capability) |
| packet replay | | identical |
| intents bench | | identical |
| smoke test | | same results (all ok) |
| adapter-lint | | error in `just check`, 0 violations |

After rebasing onto main (1ea3b1e, 0aab79f): 690 tests, all pass. The action-catalog and
LLM-tool goldens were rewritten once for an intended change from main, not from this work:
1ea3b1e raised gather_seeds' `radius` maximum from 64 to 128 (5 lines, nothing else).

### Guard bench after phase 3

Same settings and arena as phase 0, run from a snapshot of the phase 3 code (before the rebase
onto main, whose change only touches keep_fed seed gathering, not armed in the bench). Raw
results: [bench/guard-phase3.jsonl](bench/guard-phase3.jsonl).

| run | summoned | tester hits | damage | tester deaths | bot deaths | bot hits | kills |
|---|---|---|---|---|---|---|---|
| 1 | 27 | 14 | 78 | 2 | 2 | 20 | 17 |
| 2 | 27 | 27 | 96 | 2 | 2 | 29 | 17 |
| 3 | 27 | 27 | 90 | 2 | 3 | 24 | 13 |
| mean | 27 | 22.7 ± 7.5 | 88 ± 9 | 2.0 | 2.3 | 24.3 | 15.7 |

| metric | phase 0 | phase 3 |
|---|---|---|
| tester hits | 32.3 ± 4.6 | 22.7 ± 7.5 |
| tester damage | 101 ± 20 | 88 ± 9 |
| tester deaths | 2.7 | 2.0 |
| bot deaths | 2.3 | 2.3 |
| bot hits taken | 24.7 | 24.3 |
| kills | 15.7 | 15.7 |

Within run-to-run variance: the ranges overlap (phase 0 hits 27-35, phase 3 14-27, with two
runs of each at 27), the difference in mean hits is under two pooled standard deviations with
three runs a side (Welch t about 1.9, not significant), and bot deaths, bot hits and kills are
the same. No sign of a regression.

## Golden updates after phase 3

`feat/food-reach` (keep_fed food fixes) changed action schemas on purpose, so
`action-catalogs.json` and `llm-tools.json` were rewritten with `UPDATE_GOLDEN=1`:

- `hunt` has a new `reach` parameter (boolean, default true): bridge, pillar or dig to an
  animal the pathfinder can't reach on foot, within a 16-block budget.
- `find_food`: `radius` and `minRadius` go up to 1024 (from 512), for the 400 and 600 rings.
- `gather_seeds`: the description says it keeps going until it has the seeds, the time is up
  or the grass runs out.

Nothing else in the goldens changed; `observe.json`, `intent-decisions.json` and
`replay-events.json` are identical.
