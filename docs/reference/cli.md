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
| run | `just run [name] [flags]` | run one [profile](/guide/profiles) or variant (default `buddy`) |
| run | `just dev [name] [flags]` | same, restart on file changes |
| run | `just fleet [name]` | run a [fleet file](/guide/running#a-fleet): `fleets/<name>.yaml` or a path (default `example`) |
| bots | `just bots` | list variants, profiles and fleets |
| bots | `just actions [name]` | list a profile's or variant's actions |
| debug | `just probe` | connect once, print the world snapshot, quit |
| debug | `just chat-test "!help,!pos"` | join as a second player and send commands |
| debug | `just guard-bench [args]` | bodyguard mob-wave benchmark on a live server |
| debug | `just survival-bench [args]` | [survival benchmark](/guide/behaviors#survival-benchmark-just-survival-bench): a test bot alone for N in-game days; `--compare a b` |
| debug | `just smoke-test [args]` | live smoke test with test accounts |
| debug | `just replay-record [args]` | record a short session for the packet replay test |
| debug | `just reset-channels` | forget learned NeoForge channels (`data/channels-*.json`) |
| intents | `just intents-bench [args]` | benchmark the [intents](/guide/intents) layers on labelled phrasings |
| [blueprints](/guide/goals-and-building#blueprint-format) | `just blueprint-preview [name] [facing]` | print a blueprint as text, or list them |
| blueprints | `just blueprint-import <file> [--bot name \| --out dir]` | convert a `.schem` / `.schematic` / `.litematic` / `.nbt` / `.bp` into a blueprint ([Blueprint libraries](/guide/blueprints#import)) |
| blueprints | `just blueprint-fetch [args]` | download and convert the schematics in `blueprints/sources.yaml` |
| llm | `just llm-login <provider> [mode]` | log a subscription CLI (`claude`, `codex`, `opencode`) into its isolated profile in `.auth/` |
| llm | `just llm-status` | which LLM providers are logged in |
| llm | `just llm-usage [bot]` | LLM usage from a bot's [journal](/guide/journal#llm-usage) (default `Pax`) |
| llm | `just llm-eval --dry` | A/B eval of a [profile](/guide/profiles)'s [context pack](/guide/context-pack) (real providers need `--yes`) |
| docs | `just docs` | docs site dev server |
| docs | `just docs-gen` | regenerate the [action reference](/reference/actions) |
| docs | `just docs-links` | add in-text cross links between docs pages |
| docs | `just scope-check` | which directories import Mineflayer or touch `agent.bot` ([Scope](/concepts/scope)) |
| docs | `just docs-build` | static HTML in `docs/.vitepress/dist` |
| deploy | `just image [tag]` | build the container image with podman ([Deployment](/guide/deployment)) |
| check | `just check` | typecheck + unit tests + adapter lint |
| check | `just typecheck`, `just test`, `just lint-adapters` | the three parts of `check` on their own |
| check | `just parity` | offline parity checks: golden snapshots, packet replay, intents bench |

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
`--host` and `--port` also apply to `fleet`, as the base for servers that don't set them;
`--username`, `--owners` and `--dig` only apply to `run`.

## .env

The `run`, `dev`, `fleet`, `probe`, `chat-test` and live-test recipes start Node with
`--env-file-if-exists=.env`. Core also loads `.env` from the working directory itself
(`process.loadEnvFile`) when it is imported, so `node src/cli.ts` and scripts work without the
flag. Either way, variables already set in the shell win over `.env`. The file is optional:
every server setting has a default (`.env.example` lists them).

The logger loads `.env` itself before it reads `MC_LOG_*` and collects the secrets to redact,
so those work from `.env` too, with or without the flag.
