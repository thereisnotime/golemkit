---
scope: mixed
scopeNote: "run, fleet and list are game-agnostic; probes, live tests and benchmarks need a Minecraft server."
---

# CLI and just recipes

## just

`just` with no arguments lists every recipe, grouped:

| group | recipe | |
|---|---|---|
| setup | `just setup` | `npm ci`, create `.env` from `.env.example` if missing |
| run | `just run [name] [flags]` | run one [profile](/guide/profiles) or [variant](/concepts/variants-profiles) (default `buddy`) |
| run | `just dev [name] [flags]` | same, restart on file changes |
| run | `just fleet [name]` | run a [fleet file](/guide/running#a-fleet): `fleets/<name>.yaml` or a path (default `example`) |
| bots | `just bots` | list variants, profiles and [fleets](/concepts/architecture#fleets-and-multiple-servers) |
| bots | `just actions [name]` | list a profile's or variant's actions |
| debug | `just probe` | connect once with no brains, print a world snapshot (or how far login got), quit |
| debug | `just chat-test "!help,!pos"` | join as a second player and send commands |
| debug | `just guard-bench [args]` | [bodyguard benchmark](/guide/behaviors#benchmark-just-guard-bench): mob waves against guard, follow_owner and no bot; also duels and water-bucket clutches ([options](#benchmarks)) |
| debug | `just pvp-bench [args]` | [bot-vs-bot PvP benchmark](/guide/behaviors#pvp-benchmark-just-pvp-bench): PvpA vs PvpB, the PvP tactics against the old fight loop ([options](#benchmarks)) |
| debug | `just survival-bench [args]` | [survival benchmark](/guide/behaviors#survival-benchmark-just-survival-bench): a test bot alone for N in-game days ([options](#benchmarks)) |
| debug | `just smoke-test [args]` | live smoke test with test accounts |
| debug | `just replay-record [args]` | record a short session for the packet replay test |
| debug | `just reset-channels` | forget learned NeoForge channels (`data/channels-*.json`) |
| intents | `just intents-bench [args]` | benchmark the [intents](/guide/intents) layers on labelled phrasings |
| [blueprints](/guide/goals-and-building#blueprint-format) | `just blueprint-preview [name] [facing] [--top]` | print a blueprint as text, or list them |
| blueprints | `just blueprint-import <file> [--bot name \| --out dir]` | convert a `.schem` / `.schematic` / `.litematic` / `.nbt` / `.bp` into a blueprint ([Blueprint libraries](/guide/blueprints#import)) |
| blueprints | `just blueprint-fetch [args]` | download and convert the schematics in `blueprints/sources.yaml` |
| llm | `just llm-login <provider> [mode]` | log a subscription CLI (`claude`, `codex`, `opencode`) into its isolated profile in `.auth/`; mode `token` or `device`, `--login DIR` for another folder (default `MC_<PROVIDER>_LOGIN`, else `.auth/<provider>`; `--profile` is the old name) |
| llm | `just llm-status` | which LLM providers are logged in |
| llm | `just llm-usage [bot] [date] [--days N]` | LLM usage from a bot's [journal](/guide/journal#llm-usage) (default `Pax`, today) |
| llm | `just llm-eval --dry` | A/B eval of a [profile](/guide/profiles)'s [context pack](/guide/context-pack) (real providers need `--yes`) |
| docs | `just docs` | docs site dev server |
| docs | `just docs-gen` | regenerate the [action reference](/reference/actions) |
| docs | `just docs-links` | add in-text cross links between docs pages |
| docs | `just scope-check [--files]` | which directories import Mineflayer or touch `agent.bot` ([Scope](/concepts/scope)) |
| docs | `just docs-build` | static HTML in `docs/.vitepress/dist` |
| deploy | `just image [tag]` | build the container image with podman ([Deployment](/guide/deployment)) |
| check | `just check` | typecheck + unit tests + adapter lint |
| check | `just typecheck`, `just test`, `just lint-adapters` | the three parts of `check` on their own |
| check | `just parity [--save-intents]` | offline parity checks: tsc, unit tests (golden snapshots, packet replay), intents bench against its baseline, scope-check counts |

## Benchmarks

The three benchmarks drive test accounts on a live server you own. `DIRECTOR` (default
`ClaudeTest`, an op) sets up and cleans up with commands, and each one refuses spots within 300
blocks of the world spawn, the fortress and the village. Results append to
`data/<bench>/results.jsonl` and a table prints at the end. The behaviour pages linked above have
the method and the numbers; this is the option list as the scripts parse it.

**`just guard-bench [x z] [options]`** (`scripts/guard-bench.ts`; spot default `1250 445`;
accounts `GUARD_BOT` = GuardTest, `GUARD_TESTER` = GuardTester; results dir `GUARD_BENCH_DIR`)

| option | default | |
|---|---|---|
| `--minutes N` | 4 | length of each phase (or of each duel kind) |
| `--repeats N` | 2 | rounds; the phase order flips every repeat |
| `--phases a,b` | `guard,follow,none` | `guard` (bodyguard armed), `follow` (follow_owner only), `none` (bot offline) |
| `--variants a,b` | | one guard phase per variant: `all`, `no-intercept`, `no-pull`, `neither` |
| `--no-intercept`, `--no-pull` | | arm the bodyguard with that tactic off |
| `--seed N` | 1 | wave schedule seed |
| `--interval S`, `--cap N` | 30, 8 | a wave every S seconds while fewer than N mobs are alive |
| `--waves mixed\|ranged` | `mixed` | `ranged`: skeletons and pillagers only |
| `--phantoms` | off | a phantom every third wave |
| `--time day\|night` | `day` | |
| `--sword stone\|iron` | `iron` | the bot's sword |
| `--armour` | off | iron armour for the bot |
| `--no-shield`, `--bread N` | shield, 16 | a poorly geared bot |
| `--bow`, `--blocks N` | off, 0 | a bow and 32 arrows; N cobblestone for cover |
| `--tester-food N` | 8 | the tester's bread |
| `--duel kinds` | | the bot alone against one mob kind at a time (`zombie,skeleton,creeper,vindicator`) |
| `--duel-count N` | 2 | mobs kept alive per duel |
| `--clutch N`, `--clutch-height H` | 0, 22 | water bucket test: N drops from H blocks, then N fires |
| `--tag name` | `run` | label in the results |
| `--scout` | | only check the spot and the owner's distance |
| `--cleanup` | | only kill the tagged mobs and clear both players |
| `--force` | | run on a spot that is not flat and dry |

**`just pvp-bench [x z] [options]`** (`scripts/pvp-bench.ts`; arena default `1250 445`;
accounts `PVP_A` = PvpA, `PVP_B` = PvpB; results dir `PVP_BENCH_DIR`)

| option | default | |
|---|---|---|
| `--rounds N` | 6 | |
| `--match new-old\|mirror\|old-old` | `new-old` | PvP tactics against the old fight loop (sides swap every round), both with tactics, or both without |
| `--kit iron\|diamond` | `iron` | |
| `--no-bow` | bow on | |
| `--totem` | off | a totem of undying each |
| `--apples N` | 2 | golden apples each |
| `--round-s S` | 120 | a round ends at the first death or after S seconds |
| `--radius R` | 14 | half-size of the arena floor checked flat; the bots start `min(5, R - 3)` blocks either side of the centre |
| `--tag name` | `run` | |
| `--scout`, `--cleanup`, `--force` | | as in guard-bench |
| `--commands` | | owner command smoke test over whispers instead of duels |

**`just survival-bench [options]`** (`scripts/survival-bench.ts`; account `SURVIVAL_BOT` =
SurviveTest, owner `SURVIVAL_OWNER` = SurviveOwner; results dir `SURVIVAL_BENCH_DIR`)

| option | default | |
|---|---|---|
| `--days N` | 1 | in-game days (20 real minutes each) |
| `--minutes M` | days x 20 | real minutes, overrides `--days` for the length |
| `--scenario forest\|ice` | `forest` | start spot: `forest` (1818 1318), `ice` (1600 800, no tree for ~137 blocks) |
| `--start x,z` | | a custom start instead of a scenario |
| `--kit none\|stone\|iron` | `none` | |
| `--profile name` | `pax` | whose behaviours and settings the test bot runs |
| `--llm` | off | run the profile's own variant, [LLM brain](/guide/llm-brain) included (default: its behaviours without the LLM) |
| `--repeats N` | 1 | |
| `--seed N`, `--spread N` | 1, 0 | with a spread, repeats after the first start N blocks from the spot in a seeded direction |
| `--stuck N` | 5 | the same failure (action and message) seen more than N times counts as a stuck loop |
| `--tag name` | `run` | |
| `--terrain-note "text"` | | stored with the result |
| `--force` | | run with players near the start |
| `--survey "x,z x,z ..."` | | read-only look at candidate starts |
| `--compare tagA tagB` | | before/after table from the results |
| `--summary [tag]` | | table of past runs |
| `--cleanup` | | finish the clean-up of a broken run |

## node src/cli.ts

```
node src/cli.ts run <name> [-u|--username X] [--owners a,b] [--dig] [--host H] [--port P]
node src/cli.ts fleet <name|file.yaml>
node src/cli.ts list
node src/cli.ts actions <name>

logging flags (any command):
  -l, --log-level SPEC     e.g. 'info,McBuddy=debug'
  -v, --verbose            debug
  -q, --quiet              warn
  --log-format pretty|plain|json
  --log-file FILE
  --log-dir DIR
```

`<name>` is a profile (`profiles/<name>.yaml` or `.yml`, or a path to a YAML file) or, failing
that, a variant (`variants/<name>.ts`, `variants/<name>/index.ts` or a path to a `.ts` file).
`fleet` looks for `fleets/<name>.yaml`, `fleets/<name>.yml`, then treats the argument as a path.
`--host` and `--port` override `.env`, a profile's `server:` and, for `fleet`, the fleet's own
server entries (see [Running](/guide/running#a-fleet)). `--username`, `--owners` and `--dig` only apply to
`run`. `list` and `actions` don't connect.

## .env

The `run`, `dev`, `fleet`, `probe`, `chat-test`, `llm-eval`, benchmark and live-test recipes start Node with
`--env-file-if-exists=.env`. Core also loads `.env` from the working directory itself
(`process.loadEnvFile`) when it is imported, so `node src/cli.ts` and scripts work without the
flag. Either way, variables already set in the shell win over `.env`. The file is optional:
every server setting has a default (`.env.example` lists them).

The logger loads `.env` itself before it reads `MC_LOG_*` and collects the secrets to redact,
so those work from `.env` too, with or without the flag.
