---
scope: core
---

# Status and stuck alerts

Every bot keeps a status snapshot: what it is doing, why, how long since it last got anywhere,
health, food, position, the last failure and, when its decision loop knows them, the current need
and goal. You can read it three ways without digging through logs:

- **From a terminal**: `just status Pax` (or `node src/cli.ts status Pax`) reads the status file
  the running bot rewrites every 5 seconds.
- **In game**: `!status`, or plain language ("status", "what are you doing", "why are you idle",
  "are you stuck"), answered with one short chat line.
- **On its own**: when the bot wants to do something but has made no progress for 10 minutes, it
  whispers its online owners once what it is trying and why it can't, then backs off.

The code is game-agnostic (`src/core/status.ts` for the pure parts, `src/core/statusTracker.ts`
for the wiring, one tracker per agent as `agent.status`). It reads `agent.adapter` (self,
inventory, players), the agent's action events and the NPC controllers' `snapshot()`.

## What it shows

```
$ just status Pax
Pax (profile pax): STUCK
  npc       idle 14m: chop_wood_loop cooling 2m after failing: no natural tree within 64 blocks
            scores: wander 5
  trying    chop_wood_loop
  why       chop_wood_loop cooling 2m after failing: no natural tree within 64 blocks
  blocker   chop_wood_loop: no natural tree within 64 blocks
  progress  14m ago (goto ok); stuck alert after 10m
  failed    30s ago: chop_wood_loop: no natural tree within 64 blocks
  self      hp 20 food 17 at 545 70 45 (overworld)
  alerts    1 sent, last 4m ago
  process   pid 41210, rss 312 MB, up 2h 10m
  file      data/bots/Pax/status.json
```

| field | where it comes from |
|---|---|
| state | `working` (something runs or progress is recent), `busy` (a long-running order such as `follow` or `guard`, never stuck), `idle` (nothing wants to run), `stuck` (it wants to and has made no progress for `stuckAlertMs`), `offline` |
| doing | the action holding the body: name, caller (`brain:npc`, `player:Robin`, `reflex:...`), priority and for how long |
| per decision loop | each NPC controller (`npc`, `behaviors`, `self`): the running behaviour with the score that picked it, its priority and run time, or, when idle, why: suspended by a scene, body held by another caller, backing off, behaviours cooling down after failures (with the failure), a score waiting to start, or every score at 0. The top scores of the last tick |
| trying, why | what it is on (`chop_wood_loop: chop_tree` when a behaviour runs its own action) and why that, or why nothing runs |
| blocker | for `stuck`: the failure since the last progress, else who holds the body or the back-off, else the idle reason |
| need, goal | shown when the decision loop reports them (`DeciderSnapshot.need`, `.goal`) |
| progress | the last time something got done: an exclusive action that ended ok, a behaviour run that succeeded, more items in the inventory than at the last sample, or 16+ blocks away from where it last made progress (moving back and forth on the spot does not count). A loop can report its own `lastProgressAt`; other code can call `agent.status.noteProgress('what')` |
| failed | the last failure: an action that failed for a real reason (not `busy`, `preempted`, `stopped` and the like) or a failed behaviour run |
| self | health, food, position and dimension from `agent.adapter.self()` |
| process | pid, resident memory (`process.memoryUsage.rss()`), uptime |

A new session counts as a fresh start: the time it was disconnected never makes it stuck.

## From a terminal

```
just status                 # one line per bot that has a status file
just status Pax             # one bot in detail (username, profile name or data directory)
just status Pax --json      # the raw status.json
just status Pax -w          # redraw every 2 s
```

The file is `data/bots/<username>/status.json` (`data/bots/<server>/<username>/` for a fleet on
several servers), relative to where the bot was started, written atomically every
`status.intervalMs`. When the file is older than 3 intervals (at least 15 s) the command says
`NOT RUNNING, last update ... ago`, and when the bot stops it writes a last `offline` status.
The exit code is 1 when no status matches the name.

## In game

`!status` (aliases `!why`, `!stuck`) and the intents phrasings ("status", "what are you doing",
"why are you idle", "why are you standing around", "are you stuck", "what's wrong") answer with
one line of at most 240 characters:

```
STUCK 14m, on chop_wood_loop | can't: chop_wood_loop: no natural tree within 64 blocks | progress 14m ago (goto ok) | hp 20 food 17
doing chop_tree (brain:npc, 20s) | why: chop_wood_loop scored 40 | progress 35s ago (+4 items) | hp 18 food 15
```

The action is not exclusive (it never takes the body), anyone may ask, and an LLM brain gets the
full snapshot as the tool result's data. `!hp` still reports health, food and the current action.

## Stuck alert

When the state is `stuck`, the bot whispers each owner who is online:

```
Stuck for 10m: trying chop_wood_loop, can't: chop_wood_loop: no natural tree within 64 blocks. Say "status" for more.
```

It sends once, then again after `stuckAlertMs`, twice that, four times that and so on up to
`alertMaxMs` while it stays stuck. Any progress resets the back-off. With no owner online nothing
is sent and it tries on the next sample. The alert complements [asking for help](./behaviors#asking-for-help):
that one fires on the same failure repeated, this one on no progress at all (a stale holder, a
behaviour that runs without getting anywhere, every behaviour cooling down).

## Settings

```yaml
# profile (lands in settings.status); true/false or a map
status: { file: true, intervalMs: 5000, alert: true, stuckAlertMs: 600000, alertMaxMs: 7200000 }
```

| key | default | |
|---|---|---|
| `status.file` | `true` | write `status.json` for the CLI |
| `status.intervalMs` | `5000` | sample interval (progress, stuck check) and file rewrite, 1000–600000 |
| `status.alert` | `true` | whisper online owners when stuck |
| `status.stuckAlertMs` | `600000` (10 min) | no progress for this long while it wants something counts as stuck, at least 60000 |
| `status.alertMaxMs` | `7200000` (2 h) | the largest gap between repeat alerts |

`status: false` turns off the file and the alert; `!status` keeps working. All five keys are
[feature toggles](./live-config): `!config_set status.alert off`, `!config_set status.stuckAlertMs 300000`.

## From code

```ts
agent.status.snapshot()            // BotStatus (what status.json holds)
agent.status.chatLine()            // the chat line
agent.status.noteProgress('placed 12 blocks')
const off = agent.status.addSource('my-loop', () => snapshotOfMyLoop)  // a DeciderSnapshot, or null
```

`NpcController.snapshot()` returns a `DeciderSnapshot` (plain object): running behaviour, start,
score and priority, the foreign holder, back-off, suspension, idle since, top scores, cooldowns
with failure counts, last failure and last success. Its optional `need`, `goal`, `reason` and
`lastProgressAt` are for loops that know them; the status shows them when present. The npc,
behaviours and self-improver brains register their controller when a session starts.
