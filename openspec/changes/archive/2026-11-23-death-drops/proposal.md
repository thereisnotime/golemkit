# Death item recovery

## Why
Pax lost its whole kit on every death: the drops lay where it died until they despawned (6000 ticks, 5 minutes) while it went on naked from its bed. The death reports (`deathCause`) now say where and how it died, who killed it and what was around, which is enough to decide whether going back is worth it and safe.

## What changes
- `recoverPlan.ts` (pure): `recoverDecision` (go / wait / skip: lava, void, dimension, deep water, distance and time left at walking speed, player killers, threat points against the gear score, night), `tripCheck` (give up on the way), `recoveryReport` ("got back 23 of 31 items: ...").
- `recovery` skill: inventory snapshot and death record per session, `recover_items` action (walk, give up, pick up, re-equip, report), `myDrops` in observe.
- `recover_drops` behaviour at score 72, once per death, then home; armed in profiles/pax.yaml.
- Docs (behaviors, live-config, generated reference), golden catalogs gain `recover_items`.
