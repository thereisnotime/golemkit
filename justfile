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

# Run a bot from bots/ (extra args go to the CLI, e.g. --username X --owners a,b --dig)
[group('run')]
run bot="buddy" *args:
    @echo "{{BOLD}}{{GREEN}}==> starting {{bot}}{{NORMAL}}"
    node --env-file-if-exists=.env src/cli.ts run {{bot}} {{args}}

# Run a bot with auto-restart on file changes
[group('run')]
dev bot="buddy" *args:
    @echo "{{BOLD}}{{GREEN}}==> starting {{bot}} (watch mode){{NORMAL}}"
    node --watch --env-file-if-exists=.env src/cli.ts run {{bot}} {{args}}

# Run several bots in one process from a fleet file
[group('run')]
fleet file="fleet.yaml":
    @echo "{{BOLD}}{{GREEN}}==> starting fleet {{file}}{{NORMAL}}"
    node --env-file-if-exists=.env src/cli.ts fleet {{file}}

# List available bots
[group('bots')]
bots:
    @node src/cli.ts list

# List a bot's actions (= its chat commands and LLM tools)
[group('bots')]
actions bot="buddy":
    @node src/cli.ts actions {{bot}}

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
