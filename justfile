set dotenv-load := false

# Show available recipes
[group('help')]
default:
    @just --list --unsorted

# Install dependencies into ./node_modules
[group('setup')]
setup:
    @echo "{{BOLD}}{{CYAN}}==> installing dependencies{{NORMAL}}"
    npm ci
    @test -f .env || (cp .env.example .env && echo "{{YELLOW}}created .env from .env.example{{NORMAL}}")
    @echo "{{GREEN}}✔ ready, run: just run{{NORMAL}}"

# Run a profile (profiles/) or a variant (variants/); extra args go to the CLI (--username X --owners a,b --dig -v)
[group('run')]
run name="buddy" *args:
    @echo "{{BOLD}}{{GREEN}}==> starting {{name}}{{NORMAL}}"
    node --env-file-if-exists=.env src/cli.ts run {{name}} {{args}}

# Same as run, restarting on file changes
[group('run')]
dev name="buddy" *args:
    @echo "{{BOLD}}{{GREEN}}==> starting {{name}} (watch mode){{NORMAL}}"
    node --watch --env-file-if-exists=.env src/cli.ts run {{name}} {{args}}

# Run a fleet (fleets/<name>.yaml or a file path) in one process
[group('run')]
fleet name="example" *args:
    @echo "{{BOLD}}{{GREEN}}==> starting fleet {{name}}{{NORMAL}}"
    node --env-file-if-exists=.env src/cli.ts fleet {{name}} {{args}}

# List variants, profiles and fleets
[group('bots')]
bots:
    @node src/cli.ts list

# List a profile's or variant's actions (= its chat commands and LLM tools)
[group('bots')]
actions name="buddy":
    @node src/cli.ts actions {{name}}

# Connect once, report how far login gets, then quit
[group('debug')]
probe:
    @echo "{{BOLD}}{{BLUE}}==> probing server{{NORMAL}}"
    node --env-file-if-exists=.env scripts/probe.ts

# Join as a second offline player and send commands to the bot (comma-separated)
[group('debug')]
chat-test cmds="!help,!pos,!hp,!come,!follow,!inventory,!stop":
    @echo "{{BOLD}}{{BLUE}}==> chat test: {{cmds}}{{NORMAL}}"
    node --env-file-if-exists=.env scripts/chat-test.ts "{{cmds}}"

# Forget learned NeoForge channels (relearned on next join)
[group('debug')]
reset-channels:
    @echo "{{YELLOW}}==> removing learned channel caches{{NORMAL}}"
    rm -f data/channels-*.json

# Docs site dev server (http://127.0.0.1:5173)
[group('docs')]
docs: docs-gen
    @echo "{{BOLD}}{{BLUE}}==> docs dev server{{NORMAL}}"
    npx vitepress dev docs --host 127.0.0.1 --port 5173

# Regenerate the action reference from the code
[group('docs')]
docs-gen:
    @node scripts/gen-docs.ts

# Add in-text cross links between docs pages (first mention of each concept); safe to re-run
[group('docs')]
docs-links:
    @node scripts/docs-interlink.ts

# Build the static docs site into docs/.vitepress/dist
[group('docs')]
docs-build: docs-gen
    @echo "{{BOLD}}{{BLUE}}==> building docs{{NORMAL}}"
    npx vitepress build docs
    @echo "{{GREEN}}✔ open docs/.vitepress/dist/index.html (or: npx vitepress preview docs){{NORMAL}}"

# Log a subscription CLI into its isolated mc-buddy profile (claude [token] | codex [device] | opencode)
[group('llm')]
llm-login provider mode="" *args:
    @node scripts/llm-login.ts {{provider}} {{mode}} {{args}}

# Show which LLM providers are logged in (isolated profiles in .auth/)
[group('llm')]
llm-status *args:
    @node scripts/llm-login.ts status {{args}}

# A/B eval of a profile's context pack: --dry (scripted, free) or a real provider with --yes (costs quota)
[group('llm')]
llm-eval *args:
    @node --env-file-if-exists=.env scripts/llm-eval.ts {{args}}

# Print a blueprint as text (top view, layers, materials); no name lists them all
[group('blueprints')]
blueprint-preview name="" *args:
    @node scripts/blueprint-preview.ts {{name}} {{args}}

# Convert a .schem / .schematic / .litematic / .nbt / .bp into a blueprint (--bot <name> or --out <dir> to save, else print)
[group('blueprints')]
blueprint-import file *args:
    @echo "{{BOLD}}{{CYAN}}==> importing {{file}}{{NORMAL}}"
    node scripts/blueprint-import.ts "{{file}}" {{args}}

# Download the schematics in blueprints/sources.yaml and convert them (--only a,b --force --check --keep-raw)
[group('blueprints')]
blueprint-fetch *args:
    @echo "{{BOLD}}{{CYAN}}==> fetching blueprints from blueprints/sources.yaml{{NORMAL}}"
    node scripts/blueprint-fetch.ts {{args}}

# Build the container image (podman)
[group('deploy')]
image tag="mc-buddy":
    podman build -t {{tag}} .

# Typecheck + unit tests
[group('check')]
check: typecheck test

# Typecheck everything (tsc, no emit)
[group('check')]
typecheck:
    @echo "{{BOLD}}{{MAGENTA}}==> typecheck{{NORMAL}}"
    npx tsc -p .

# Unit tests
[group('check')]
test:
    @echo "{{BOLD}}{{MAGENTA}}==> tests{{NORMAL}}"
    npm test --silent
