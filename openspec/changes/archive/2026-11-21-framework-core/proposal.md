## Why

mc-buddy should be a base for many kinds of bots: player assistants, self-sufficient NPCs, NPCs with LLM loops. The first version hard-wired one bot's commands and behaviours.

## What Changes

- Port to TypeScript (Node type stripping, tsc for typecheck only).
- Core framework: Agent (lifecycle, reconnect, sessions), actions with zod schemas, an action lock with caller priorities and resumable long-running actions, skills, brains, storage, rate-limited chat, observe() snapshots, action catalog as JSON schema for LLM tools.
- Skills: status, movement, combat, survival, inventory, gather.
- Brains: command (any action is a chat command), reflexes (self-defence, auto-eat).
- Bot definitions in bots/, CLI with run / fleet / list / actions.
