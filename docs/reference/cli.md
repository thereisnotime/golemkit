# CLI and just recipes

## just

`just` with no arguments lists every recipe, grouped:

| group | recipe | |
|---|---|---|
| setup | `just setup` | `npm ci`, create `.env` |
| run | `just run [bot] [flags]` | run one bot (default `buddy`) |
| run | `just dev [bot] [flags]` | same, restart on file changes |
| run | `just fleet [file]` | run a [fleet file](/guide/running#a-fleet) (default `fleet.yaml`) |
| bots | `just bots` | list bot definitions |
| bots | `just actions [bot]` | list a bot's actions |
| debug | `just probe` | connect once, print the world snapshot |
| debug | `just chat-test "!help,!pos"` | join as a second player and send commands |
| debug | `just reset-channels` | forget learned NeoForge channels |
| [blueprints](/guide/goals-and-building#blueprint-format) | `just blueprint-preview [name] [facing]` | print a blueprint as text, or list them |
| blueprints | `just blueprint-import <file> [--bot name \| --out dir]` | convert a `.schem` / `.litematic` / `.nbt` into a blueprint ([Blueprint libraries](/guide/blueprints#import)) |
| llm | `just llm-eval --dry` | A/B eval of a [profile](/guide/profiles)'s [context pack](/guide/context-pack) (real providers need `--yes`) |
| docs | `just docs` | docs site dev server |
| docs | `just docs-gen` | regenerate the [action reference](/reference/actions) |
| docs | `just docs-build` | static HTML in `docs/.vitepress/dist` |
| check | `just check` | typecheck + unit tests |

## node src/cli.ts

```
node src/cli.ts run <bot> [--username X] [--owners a,b] [--dig] [--host H] [--port P]
node src/cli.ts fleet <file.yaml>
node src/cli.ts list
node src/cli.ts actions <bot>

logging flags (any command):
  -l, --log-level SPEC     e.g. 'info,McBuddy=debug'
  -v, --verbose            debug
  -q, --quiet              warn
  --log-format pretty|plain|json
  --log-file FILE
  --log-dir DIR
```

`<bot>` is a name in `variants/` or a path to a definition file. `.env` is loaded by the just
recipes (`node --env-file-if-exists=.env`).
