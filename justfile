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

# Run the bot (reads .env if present)
[group('run')]
run:
    @echo "{{BOLD}}{{GREEN}}==> starting mc-buddy{{NORMAL}}"
    npm start

# Run with auto-restart on file changes
[group('run')]
dev:
    @echo "{{BOLD}}{{GREEN}}==> starting mc-buddy (watch mode){{NORMAL}}"
    npm run dev

# Connect once, report how far login gets, then quit
[group('debug')]
probe:
    @echo "{{BOLD}}{{BLUE}}==> probing server{{NORMAL}}"
    node --env-file-if-exists=.env scripts/probe.js

# Join as a second offline player and send commands to the bot (comma-separated)
[group('debug')]
chat-test cmds="!help,!pos,!hp,!come,!follow,!inv,!stop":
    @echo "{{BOLD}}{{BLUE}}==> chat test: {{cmds}}{{NORMAL}}"
    node --env-file-if-exists=.env scripts/chat-test.js "{{cmds}}"

# Forget learned NeoForge channels (relearned on next join)
[group('debug')]
reset-channels:
    @echo "{{YELLOW}}==> removing data/ (learned channels){{NORMAL}}"
    rm -rf data/

# Syntax check + unit tests
[group('check')]
check: lint test

# Syntax check all sources
[group('check')]
lint:
    @echo "{{BOLD}}{{MAGENTA}}==> lint{{NORMAL}}"
    npm run lint --silent

# Unit tests
[group('check')]
test:
    @echo "{{BOLD}}{{MAGENTA}}==> tests{{NORMAL}}"
    npm test --silent
