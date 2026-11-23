// What the stock behaviours are trying to do and what would help when they keep failing the
// same way (settings.askHelp, brains/npc/help.ts). Kept in one table so the behaviour files stay
// as they are; a behaviour's own goal/help (keep_fed) wins over these.
import type { BehaviorDefinition } from '../../../brains/behaviors/types.ts'
import type { Failure } from '../../../brains/npc/help.ts'

type Hint = [RegExp, string]

/** Failures any behaviour can hit, checked after the behaviour's own hints. */
const COMMON: Hint[] = [
  [/no path|path was stopped|can.?t reach|cannot reach|unreachable|stuck at|timed? ?out/, 'a clear path (or a door) to where I am going'],
  [/inventory (is )?full|no (free|empty) slot/, 'a chest near home to put things in'],
  [/server (won.?t|refused)|protected/, 'a spot where the server lets me dig and build']
]

const STOCK: Record<string, { goal: string, hints: Hint[], fallback?: string }> = {
  keep_tools_upgraded: {
    goal: 'upgrade my tools',
    hints: [
      [/stick|plank|wood|log/, 'a few logs or planks in my chest'],
      [/not ready|weapon|armou?r|shield|deeper/, 'a sword, some food and a shield or armour, so I can mine deeper'],
      [/coal|charcoal|fuel|smelt/, 'some coal or charcoal'],
      [/furnace|cobble|stone/, 'some cobblestone (or a furnace near home)'],
      [/iron|ore/, 'a few iron ingots or iron ore'],
      [/diamond/, 'a few diamonds']
    ],
    fallback: 'materials for the next tool (logs, cobblestone, iron)'
  },
  chop_wood_loop: {
    goal: 'keep a stock of wood',
    hints: [[/tree|forest|sapling/, 'a few logs in my chest, or a forest I may cut (remember_place)']],
    fallback: 'a few logs in my chest'
  },
  return_home: { goal: 'get home', hints: [[/home|path|reach/, 'a path or door into my home, or a home I can reach (set_home)']] },
  sleep_at_night: { goal: 'sleep at night', hints: [[/bed/, 'a bed near home'], [/home|path|reach/, 'a path or door into my home']] },
  stay_safe: { goal: 'stay safe', hints: [[/home|path|reach/, 'a path or door into my home, or a home I can reach (set_home)']] },
  keep_spawn_bed: { goal: 'keep a spawn bed', hints: [[/bed|wool|craft/, 'a bed, or 3 wool and some planks']] },
  deposit_when_full: { goal: 'empty my inventory', hints: [[/chest|barrel|container/, 'a chest near home (or one I remember, remember_place)']], fallback: 'a chest near home' },
  farm_setup: {
    goal: 'start and tend a farm',
    hints: [[/seed/, 'seeds or 2 animals'], [/water/, 'water near home'], [/hoe/, 'a hoe'], [/dirt|grass|soil|till/, 'a patch of dirt or grass near home']]
  },
  farm_loop: { goal: 'tend the fields', hints: [[/seed/, 'some seeds'], [/hoe/, 'a hoe']] },
  light_area: { goal: 'light up the area', hints: [[/torch|coal|charcoal|stick/, 'some torches, or coal and sticks']], fallback: 'some torches' },
  collect_drops: { goal: 'pick up drops', hints: [] },
  follow_owner: { goal: 'follow you', hints: [[/path|reach|far|see/, 'you coming closer, or a path to where you are']] },
  guard_owner: { goal: 'guard you', hints: [[/path|reach|far|see/, 'you coming closer, or a path to where you are']] },
  bodyguard: { goal: 'guard you', hints: [[/path|reach|far|see/, 'you coming closer, or a path to where you are']] },
  guard_area: { goal: 'guard the area', hints: [] },
  check_storage: { goal: 'keep track of my chests', hints: [[/open|chest|loaded/, 'a clear way to my chests near home']] }
}

/** The "what would help" text for a stock behaviour's failure, or undefined. */
export function stockHelp (name: string, failure: Pick<Failure, 'reason' | 'key' | 'messages'>): string | undefined {
  const s = STOCK[name]
  const text = [failure.reason, ...failure.messages].join(' ').toLowerCase()
  for (const [re, help] of [...(s?.hints ?? []), ...COMMON]) if (re.test(text)) return help
  return s?.fallback
}

export function stockGoal (name: string): string | undefined {
  return STOCK[name]?.goal
}

/** Gives the stock definitions their goal and help hook (unless they have their own). */
export function withStockHelp (defs: BehaviorDefinition<any>[]): BehaviorDefinition<any>[] {
  return defs.map(d => (d.help && d.goal) ? d : {
    ...d,
    goal: d.goal ?? stockGoal(d.name),
    help: d.help ?? ((_ctx, f) => stockHelp(d.name, f))
  })
}
