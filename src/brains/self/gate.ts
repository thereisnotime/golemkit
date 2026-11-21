// The gate every new program passes before the bot switches to it:
//   1. zod validation + catalog checks + static limits (format.ts parseProgram)
//   2. a dry run: every rule, trigger and routine is executed by the real interpreter against
//      simulated worlds (day/night, players/hostiles near or not, low health) with a fake host
//      and a virtual clock. It must finish within the step and time caps, and every action it
//      calls must be allowed and get valid parameters after templates are filled in.
import { ok, type ActionResult } from '../../core/index.ts'
import { parseProgram, type ActionCatalog, type Program, type Scalar } from './format.ts'
import { CapExceeded, ChatLimiter, ProgramMemory, RoutineFailed, evalCond, runRoutine, stepsOf, type Host, type World } from './interpreter.ts'

export interface Scenario {
  name: string
  facts: Record<string, Scalar>
}

const base: Record<string, Scalar> = {
  health: 20, food: 20, timeOfDay: 6000, isNight: false, isDay: true, sleeping: false, busy: false,
  homeDistance: 5, playersNearby: 0, hostilesNearby: 0,
  'nearestPlayer.name': '', 'nearestPlayer.distance': -1, 'nearestHostile.name': '', 'nearestHostile.distance': -1
}

export const DEFAULT_SCENARIOS: Scenario[] = [
  { name: 'quiet day', facts: { ...base } },
  { name: 'day with a player near', facts: { ...base, playersNearby: 1, 'nearestPlayer.name': 'Steve', 'nearestPlayer.distance': 4 } },
  { name: 'night far from home', facts: { ...base, timeOfDay: 18000, isNight: true, isDay: false, homeDistance: 40 } },
  { name: 'dusk, hurt, hostile near', facts: { ...base, timeOfDay: 12500, health: 6, food: 5, hostilesNearby: 1, 'nearestHostile.name': 'zombie', 'nearestHostile.distance': 6 } }
]

export class SimWorld implements World {
  readonly facts: Record<string, Scalar>
  constructor (facts: Record<string, Scalar>) { this.facts = facts }
  fact (name: string): Scalar | undefined {
    if (name in this.facts) return this.facts[name]
    if (name.startsWith('need.')) return 0
    if (name.startsWith('inventory.')) return 0
    if (name.startsWith('place.')) return 10
    return undefined
  }
  playerDistance (name: string): number | undefined {
    return name === this.facts['nearestPlayer.name'] ? Number(this.facts['nearestPlayer.distance']) : undefined
  }
}

export interface DryRunCall { name: string, params: Record<string, unknown> }

export interface DryRunReport {
  runs: number
  calls: DryRunCall[]
  said: number
  /** Longest simulated routine, ms. */
  longestMs: number
  issues: string[]
}

/** Runs everything in the program against the scenarios. Pure: no agent, no world, no timers. */
export async function dryRun (program: Program, catalog: ActionCatalog, scenarios: Scenario[] = DEFAULT_SCENARIOS): Promise<DryRunReport> {
  const report: DryRunReport = { runs: 0, calls: [], said: 0, longestMs: 0, issues: [] }
  const targets: [string, Program['routines'][string], string | undefined][] = [
    ...program.rules.map(r => [`rule ${r.name}`, stepsOf(program, r.do), undefined] as [string, any, undefined]),
    ...program.triggers.map(t => [`trigger ${t.name}`, stepsOf(program, t.do), 'Steve'] as [string, any, string]),
    ...Object.entries(program.routines).map(([n, s]) => [`routine ${n}`, s, undefined] as [string, any, undefined])
  ]
  const seen = new Set<string>()
  for (const sc of scenarios) {
    for (const rnd of [0.05, 0.95]) {
      const world = new SimWorld(sc.facts)
      const memory = new ProgramMemory(program.vars)
      let clock = 0
      const host: Host = {
        act: async (name, params): Promise<ActionResult> => {
          clock += 500
          const why = catalog.denied(name)
          if (why) throw new DryRunError(why)
          const p = catalog.get(name)!.params.safeParse(params)
          if (!p.success) throw new DryRunError(`bad params for ${name} after filling templates: ${p.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
          report.calls.push({ name, params })
          return ok('simulated')
        },
        say: () => { report.said++ },
        whisper: () => { report.said++ },
        wait: async (ms) => { clock += ms },
        now: () => clock,
        random: () => rnd
      }
      for (const r of program.rules) if (r.when) evalCond(r.when, { world, memory, host })
      for (const [label, steps, player] of targets) {
        const key = `${label}: `
        const start = clock
        report.runs++
        try {
          await runRoutine(steps, {
            program, world, memory, host, chat: new ChatLimiter({ gapMs: 0, perMinute: 1000 }), player: player ?? (sc.facts['nearestPlayer.name'] as string || undefined), bot: 'Bot'
          })
        } catch (e) {
          if (e instanceof RoutineFailed) { /* a `fail` step is a legitimate outcome */ } else {
            const msg = `${key}${e instanceof CapExceeded ? `does not terminate in time (${e.message})` : (e as Error).message} [scenario: ${sc.name}]`
            if (!seen.has(`${label}|${(e as Error).message}`)) { seen.add(`${label}|${(e as Error).message}`); report.issues.push(msg) }
          }
        }
        report.longestMs = Math.max(report.longestMs, clock - start)
      }
    }
  }
  return report
}

class DryRunError extends Error {}

export type GateResult =
  | { ok: true, program: Program, report: DryRunReport }
  | { ok: false, issues: string[], stage: 'validate' | 'dry-run' }

/** Validation, catalog and static checks, then the dry run. */
export async function gate (raw: unknown, catalog: ActionCatalog, scenarios?: Scenario[]): Promise<GateResult> {
  const parsed = parseProgram(raw, catalog)
  if (!parsed.ok) return { ok: false, issues: parsed.issues, stage: 'validate' }
  const report = await dryRun(parsed.program, catalog, scenarios)
  if (report.issues.length) return { ok: false, issues: report.issues, stage: 'dry-run' }
  return { ok: true, program: parsed.program, report }
}

