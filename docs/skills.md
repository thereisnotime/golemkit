# Skills

Every skill and action that ships with mc-buddy. Parameters, defaults and flags for each
action are in the generated [action reference](./reference/actions.md); this page says what
each one is for and how it behaves.

Two bundles live in `src/skills/index.ts`:

- `standardSkills()`: status, movement, combat, survival, inventory, gather.
- `extendedSkills()`: crafting, containers, farming, woodcutting, building, pickup.

`navigation()` is exported on its own (the villager bot uses it).

```ts
import { standardSkills, extendedSkills } from '../src/skills/index.ts'
export default defineVariant({ name: 'farmer', skills: [...standardSkills(), ...extendedSkills()], brains: [...] })
```

Non-exclusive actions (marked *ne*) run alongside whatever holds the body. Actions marked
*dig* need digging enabled (`canDig`, `--dig`, `MC_CAN_DIG=true`) and fail politely otherwise.

## Standard and navigation

### status
| action | |
|---|---|
| `pos` *ne* | Report position and dimension. |
| `hp` *ne* | Health, food and the current action. |
| `stop` *ne* | Stop whatever the bot is doing. |
| `say` *ne* | Say something in public chat. |

### movement
| action | |
|---|---|
| `come` | Walk to a player (default: whoever asked). |
| `follow` | Follow a player until stopped (long-running). |
| `goto` | Walk to coordinates; omit y for the surface. |
| `goto_player` | Walk to where a player is now, once. |
| `look_at` *ne* | Turn to look at a player. |
| `jump` *ne* | Jump once. |

### combat
| action | |
|---|---|
| `attack` | Fight the nearest hostile mob, or an entity by id. |
| `guard` | Protect a player from hostile mobs until stopped (long-running). |
| `defend` | Fight back at the closest hostile (internal, used by reflexes). |

### survival
| action | |
|---|---|
| `eat` | Eat the best food in the inventory. |
| `sleep` | Sleep in a bed within 16 blocks. |
| `wake` | Get out of bed. |

### inventory
| action | |
|---|---|
| `inventory` *ne* | List what the bot carries. |
| `drop` | Throw items towards the player, or `all`. |
| `equip` | Hold an item in the main hand. |

### gather
| action | |
|---|---|
| `collect` *dig* | Mine N blocks of one type nearby and pick up the drops. |

### navigation
| action | |
|---|---|
| `wander` | Short walk to a random spot near home (or a given center, or where the bot stands). |
| `set_home` *ne* | Remember a home position (default: here). |
| `go_home` | Walk back home. |
| `remember_place` *ne* | Remember a named place to walk back to later. |
| `forget_place` *ne* | Forget a named place. |
| `places` *ne* | List home and remembered places. |
| `goto_place` | Walk to a remembered place. |
| `flee` | Run from the nearest hostile mob until it is far enough away. |

## Extended

### crafting
| action | |
|---|---|
| `craft` | Craft N of an item from the inventory. Uses a crafting table within 16 blocks, or places one (from the inventory, or crafted from planks) and says where. Crafts in chunks and switches recipe variants (plank types) as materials run out. |
| `smelt` | Smelt N items in a furnace within 32 blocks (or one placed from the inventory). Picks fuel (coal, charcoal, planks, logs, sticks; never the input), polls the output once a second and takes results until done, the furnace stops burning, or ~10 s per item passes. |

Recipes come from minecraft-data, not the server (its recipe packet carries modded items and
is skipped), so modded recipes aren't craftable. Only the item itself is crafted, not its
ingredients.

### containers
| action | |
|---|---|
| `deposit` | Store an item, or `all`, in the nearest chest/barrel/shulker box or the one at x y z. `all` keeps tools, armour, food and anything in `keep`. Reports partial deposits when the container fills up. |
| `withdraw` | Take N of an item (or `all`) out of a container. Stops when the inventory is full. |
| `list_container` *ne* | What's inside. Opens it only when it is within reach and the bot is idle; otherwise answers from what the bot saw last time it opened it (in memory). |

Observe hook: `containersNearby` (within 16 blocks).

### farming
| action | |
|---|---|
| `harvest` | Break ripe wheat, carrots, potatoes and beetroot in a radius (ripeness from the block's `age`), replant with the matching seed, pick up drops, then re-seed any farmland it left bare. |
| `plant` | Plant seeds (`wheat_seeds`, `carrot`, `potato`, `beetroot_seeds`) on empty farmland. |
| `till` *dig* | Hoe dirt/grass into farmland at x y z, or the nearest spots within 4 blocks of water. |

Harvest and plant don't change terrain, so they work with digging off. Observe hook:
`ripeCropsNearby`.

### woodcutting
| action | |
|---|---|
| `chop_tree` *dig* | Fell the nearest natural tree of any wood type: cut its logs bottom-up with the best axe, skip logs out of reach, pick up drops and plant a matching sapling on the stump's soil. |

A "natural tree" is a connected group of logs with at least three non-persistent leaves
attached. Player-placed leaves are persistent, so log walls, cabins and log piles are left
alone. Very tall trees (big spruce, jungle) leave their upper logs standing; the result says
how many were out of reach.

### building
| action | |
|---|---|
| `place_block` | Place a block from the inventory at x y z against any solid neighbour (never a chest, door or other block that would open/toggle, never a modded block). |

### pickup
| action | |
|---|---|
| `pickup_items` | Walk over dropped items within a radius, optionally only one item type. Skips drops it can't reach. |

Observe hook: `droppedItemsNearby`.

## Helpers for skill authors

`src/skills/world.ts` and `pickup.ts` export the pieces the extended skills are built from:
`placeAt(bot, item, pos, signal)`, `reachBlock(bot, pos, signal)`,
`pickupNearby(bot, signal, opts)`, `findFreeSpot(bot)`, `findItem`, `countItem`, `vec`.

## Trying actions on a live server

`scripts/skill-test.ts` joins with both bundles and runs actions in order:

```sh
MC_CAN_DIG=true node scripts/skill-test.ts scan 'chop_tree {"radius":16}' 'craft {"item":"stick","count":4}' inventory
```

`scan` lists nearby logs, crops and containers; `observe` prints the world snapshot.
