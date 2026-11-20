## Why

Several NPC bots on one server can talk to each other through the fleet bus, but there is no way to make them act out something together. We want staged events and small "living world" moments (a cart breaks down, two villagers gossip on a walk) that players can watch and step into, written as data so people can add scenes without touching the engine.

## What Changes

- Scene format: TS objects with a typed builder, or YAML files under `scenes/`, validated with zod. Roles with requirements, an anchor plus named marks, beats (say, act, goto, look, wait, cue/await, parallel, repeat, choose, if/else, set), player interaction hooks (approach, chat, hit) and a `lineProvider` hook for varying lines.
- Scene engine in `src/brains/scene/`: `sceneBrain()` plus a director. Casting among scene bots on the same server, deterministic director election, recasting when a cast member drops, cues over the fleet bus, scene state on the per-server blackboard, scheduling (interval, game time, players nearby, ambient filler).
- Control actions `scene_start`, `scene_stop`, `scene_status`, `scene_list` (usable through the command brain) and a few internal stage actions (`scene_walk`, `scene_look`, `scene_gesture`).
- Core: new `PRIORITY.scene` (25, between npc and llm) and `Agent.cancelActions(match)` so a scene can stop exactly the actions it started.
- Demo scenes `scenes/broken_cart.yaml` and `scenes/gossip_walk.yaml`, `bots/actor.ts`, `fleet.scene.example.yaml`, `docs/scenes.md`.

## Impact

- Additive. Existing brains and priorities keep working; `PRIORITY.scene` sits between existing levels and `cancelActions` is a new method.
