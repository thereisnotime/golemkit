## 1. Program format
- [x] 1.1 zod schemas for rules, routines, steps, conditions, triggers; recursive parsing with paths
- [x] 1.2 catalog checks (params, unknown keys, deny list, long-running, program_*)
- [x] 1.3 static limits, references, recursion, placeholders; patches and diff summary
- [x] 1.4 generated format spec for the LLM

## 2. Runtime
- [x] 2.1 interpreter with step/time caps, chat limiter, templates
- [x] 2.2 compile rules/triggers to NpcController behaviours; trigger queue
- [x] 2.3 live fact view; trigger sources (interval, time, chat, hurt, death, playerJoined, spawn)

## 3. Self-modification
- [x] 3.1 instruction intake (prefix, mention, whisper, !teach, inbox), owners only
- [x] 3.2 LLM step via submit_program with gate and repairs; shared budget/usage
- [x] 3.3 gate: validation + dry run
- [x] 3.4 versions on disk, rollback/reset, program_* actions
- [x] 3.5 experience counters and asking the owner

## 4. Bot, docs, tests
- [x] 4.1 variants/apprentice.ts and profiles/apprentice.yaml
- [x] 4.2 unit tests (format, interpreter, gate, versions, intake, fake LLM)
- [x] 4.3 docs/guide/self-improver.md, sidebar, README line
- [x] 4.4 live test on mc02
