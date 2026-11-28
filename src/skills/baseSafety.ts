// Base safety for Minecraft: reads the ground under and around the settled base into the pure
// scan (baseSafetyPlan.ts), reports what it found (chat, status, site health: the base is marked
// unsafe with the reason) and works the fixes in a bounded session: caps on mine entrances by the
// walls, filler in openings and small cavities, torches in what stays open. Run as the base
// project "integrity" (src/skills/projects.ts) between other chores, or by hand with check_base /
// secure_base. Settings: baseSafety (src/core/baseSafety.ts). See docs/guide/base-safety.md.
import type { Bot } from 'mineflayer'
import type { ActionContext, ActionResult, Agent } from '../core/index.ts'
import { ok, fail, checkAborted, fmtPos, siteBook, baseSafetySettings, type BaseSafetySettings } from '../core/index.ts'
import { vec, digBlock } from './world.ts'
import { placeBlockState, reachToDig, NotPlaceableYet } from './placement.ts'
import { inventoryCounts, equipFor } from './toolkit.ts'
import { isFiller } from './survival.ts'
import { supplyTorches } from './lighting.ts'
import { craftItem } from './crafting.ts'
import { takeItemsFromOwnChests } from './containers.ts'
import { settledBase, type SettledBase } from './baseArea.ts'
import { getMines, saveMine } from './stairMine.ts'
import { capItem, placeCap, type PlacedCap } from './caps.ts'
import {
  scanBase, planFixes, mineFindings, planMineCaps, retireMine, mineCells, describeCavity, planHoleFills, describeHole,
  fillStepTarget, pickFiller, FLOOR_STONE, SOIL,
  type Look, type MineRef, type FixStep, type CavityFix, type MineFinding, type ScanResult
} from './baseSafetyPlan.ts'

export interface BaseCheck {
  base: SettledBase
  settings: BaseSafetySettings
  scan: ScanResult
  fixes: CavityFix[]
  mines: MineFinding[]
  /** Everything to do, in working order: caps, seals, fills, torches. */
  steps: FixStep[]
  /** What no technique fixes. */
  unfixed: string[]
  /** One line per problem, for chat and status. */
  lines: string[]
}

/** The world as the scan reads it: solid = a full block, plus block and sky light. */
export function lookFor (bot: Bot): Look {
  return p => {
    const b = bot.blockAt(vec(bot, p.x, p.y, p.z)) as unknown as { name: string, boundingBox: string, light?: number, skyLight?: number } | null
    if (!b) return undefined
    return { name: b.name, solid: b.boundingBox === 'block', ...(typeof b.light === 'number' ? { light: b.light } : {}), ...(typeof b.skyLight === 'number' ? { sky: b.skyLight } : {}) }
  }
}

/** Its staircase mines in this dimension, with the blocks they dug. */
function mineRefs (agent: Agent, bot: Bot): MineRef[] {
  const dim = bot.game?.dimension
  return getMines(agent).filter(m => !m.dim || !dim || m.dim === dim).map(m => ({ id: m.id, entrance: m.entrance, cells: [...mineCells(m), ...(m.start ?? [])] }))
}

const reported = new WeakMap<object, { at: number, open: boolean }>()

const ORDER: Record<string, number> = { cap: 0, seal: 1, fill: 2, light: 3 }

/** Scans the base and plans the fixes; null when there is no settled base or base safety is off. Reports the base's site health. */
export function checkBase (agent: Agent, bot: Bot): BaseCheck | string {
  const settings = baseSafetySettings((agent.settings as { baseSafety?: unknown }).baseSafety)
  if (!settings.enabled) return 'base safety is off (settings baseSafety.enabled)'
  const base = settledBase(agent)
  if (!base) return 'no settled base yet (base projects settle it when work starts, or set settings projects.base)'
  const look = lookFor(bot)
  const refs = mineRefs(agent, bot)
  // a farm plot inside the walls is soil: a hole there is filled with dirt
  const plot = agent.storage.get<{ farm_plot?: { x0: number, z0: number, size: number } }>('projects.spots', {})?.farm_plot
  const area = plot ? { ...base.area, soil: (x: number, z: number) => x >= plot.x0 && x < plot.x0 + plot.size && z >= plot.z0 && z < plot.z0 + plot.size } : base.area
  const scan = scanBase(area, look, { margin: settings.margin, depth: settings.depth, floorHoles: settings.floorHoles, clearFixtures: settings.clearFixtures }, refs)
  const fixes = planFixes(scan.threats, settings, refs)
  const mines = mineFindings(refs, base.area, look, settings.mineClearance)
  const caps = planMineCaps(mines, settings)
  const holeSteps = planHoleFills(scan.holes)
  // a torch already standing on the spot is done: the light reading can stay low next to one
  // (Pax's integrity project stalled three sessions on "torch is already there")
  const torchThere = (s: FixStep) => s.action === 'torch' && /(^|_)torch$/.test(look(s.pos)?.name ?? '')
  // a fill into a cell holding a torch (often its own, lighting the spot) failed every session
  // with "torch is already there": break it first; crops, a rail or a sign are not ours, so no step
  const fillable = (s: FixStep): FixStep | null => {
    if (s.action !== 'fill') return s
    const t = fillStepTarget(look(s.pos), settings.clearFixtures)
    return t === 'done' || t === 'skip' ? null : t === 'clear' ? { ...s, clear: true } : s
  }
  const steps = [...caps.steps, ...holeSteps, ...fixes.flatMap(f => f.steps)].filter(s => !torchThere(s)).map(fillable).filter((s): s is FixStep => !!s)
    .sort((a, b) => (ORDER[a.technique] ?? 9) - (ORDER[b.technique] ?? 9))
  const unfixed = [...caps.unfixed, ...fixes.filter(f => f.unfixed).map(f => `${describeCavity(f.cavity)}: ${f.unfixed}`)]
  const lines = [
    ...mines.filter(f => !f.capped).map(f => `mine ${f.mine.id} at ${fmtPos(f.mine.entrance)}: entrance ${f.problem}${f.caps.length ? `, ${f.caps.length} open block${f.caps.length === 1 ? '' : 's'} to cap` : ''}`),
    ...scan.holes.map(h => `${describeHole(h)}: fill ${h.supported ? h.cells.length : 1}${h.clear.length ? `, break ${h.clear.length} torch or flower first` : ''}`),
    ...fixes.map(f => `${describeCavity(f.cavity)}${f.steps.length ? `: ${stepText(f.steps)}` : ''}${f.unfixed ? `; ${f.unfixed}` : ''}`)
  ]
  if (scan.unknown > 0) lines.push(`${scan.unknown} blocks not loaded (not judged)`)
  // site health: the base is unsafe while something is open (written on a change, else every 5 min)
  const open = steps.length + unfixed.length > 0
  const last = reported.get(agent)
  const now = Date.now()
  if (!last || last.open !== open || now - last.at > 5 * 60_000) {
    reported.set(agent, { at: now, open })
    try {
      siteBook(agent).report({ kind: 'base', id: base.template, pos: { ...base.origin }, label: `my ${base.template}` },
        open ? { ok: false, fault: 'unsafe', reason: lines.slice(0, 2).join('; ').slice(0, 200) || 'open to mobs' } : { ok: true })
    } catch {}
  }
  return { base, settings, scan, fixes, mines, steps, unfixed, lines }
}

function stepText (steps: readonly FixStep[]): string {
  const n: Record<string, number> = {}
  for (const s of steps) n[s.technique] = (n[s.technique] ?? 0) + 1
  return Object.entries(n).map(([t, c]) => `${t} ${c}`).join(', ')
}

type Ctx = Pick<ActionContext, 'bot' | 'agent' | 'signal' | 'log'>

/** The filler blocks it carries, name -> count. */
const carriedFillers = (bot: Bot): Record<string, number> => Object.fromEntries(Object.entries(inventoryCounts(bot)).filter(([k]) => isFiller(k)))

/**
 * Gets filler from its chests (it crafts nothing: cobblestone and dirt are what it digs anyway):
 * dirt for `soil` of them, cobblestone for the `floor` blocks when it carries no floor stone, and
 * cobblestone up to `need` in all. What it carries already counts, whatever it is.
 */
async function supplyFiller (ctx: Ctx, need: number, soil = 0, floor = 0): Promise<number> {
  const bot = ctx.bot as Bot
  const have = () => Object.values(carriedFillers(bot)).reduce((a, v) => a + v, 0)
  const count = (names: readonly string[]) => names.reduce((a, n) => a + (inventoryCounts(bot)[n] ?? 0), 0)
  if (soil > count(SOIL)) await takeItemsFromOwnChests({ bot, agent: ctx.agent as Agent, signal: ctx.signal }, { dirt: soil - count(SOIL) }, 64).catch(e => { checkAborted(ctx.signal) })
  if (floor > count(FLOOR_STONE)) await takeItemsFromOwnChests({ bot, agent: ctx.agent as Agent, signal: ctx.signal }, { cobblestone: floor - count(FLOOR_STONE) }, 64).catch(e => { checkAborted(ctx.signal) })
  if (have() >= need) return have()
  await takeItemsFromOwnChests({ bot, agent: ctx.agent as Agent, signal: ctx.signal }, { cobblestone: need - have() }, 64).catch(e => { checkAborted(ctx.signal) })
  return have()
}

/** A trapdoor or two from its planks when it has none (a cap falls back to a block otherwise). */
async function supplyTrapdoors (ctx: Ctx, need: number): Promise<void> {
  const bot = ctx.bot as Bot
  const inv = inventoryCounts(bot)
  if (Object.entries(inv).some(([k, v]) => /_trapdoor$/.test(k) && k !== 'iron_trapdoor' && v >= need)) return
  const planks = Object.entries(inv).filter(([k, v]) => /_planks$/.test(k) && v >= 3).sort((a, b) => b[1] - a[1])[0]
  if (!planks) return
  const wood = planks[0].replace(/_planks$/, '')
  await craftItem(bot, ctx.signal, `${wood}_trapdoor`, Math.ceil(need / 2) * 2).catch(e => { checkAborted(ctx.signal) })
}

/**
 * One session on the base's safety: the steps in order (caps, seals, fills, torches) until done or
 * `minutes` are up. A cap is remembered on its mine (the next trip takes it off and puts it back).
 */
export async function secureBase (ctx: Ctx, check: BaseCheck, minutes: number): Promise<ActionResult> {
  const bot = ctx.bot as Bot
  const { agent, signal, log } = ctx
  const until = Date.now() + minutes * 60_000
  const bs = baseSafetySettings((agent.settings as { baseSafety?: unknown }).baseSafety)
  // a close mine that is capped already (by an earlier session, the floor, a player) is retired too
  const retiredNow: string[] = []
  for (const f of check.mines) {
    if (!f.capped) continue
    const m = getMines(agent as Agent).find(x => x.id === f.mine.id)
    if (!m || !retireMine(m, true, bs)) continue
    saveMine(agent as Agent, { ...m, retired: { at: Date.now(), why: 'outside the walls and too close to them: capped, a new mine goes inside the base' } })
    retiredNow.push(m.id)
  }
  if (!check.steps.length) {
    const r = retiredNow.length ? `retired ${retiredNow.join(', ')} (capped already; the next mine goes inside the base); ` : ''
    return check.unfixed.length ? fail(`${r}nothing I can do: ${check.unfixed.join('; ')}`) : ok(`${r}the base is mob-proof: no open cavity, hole in the floor or mine entrance by it`)
  }
  const fills = check.steps.filter(s => s.action === 'fill').length
  const torches = check.steps.filter(s => s.action === 'torch').length
  const caps = check.steps.filter(s => s.action === 'cap')
  const notes: string[] = retiredNow.map(id => `retired ${id} (capped already; the next mine goes inside the base)`)
  if (fills) await supplyFiller(ctx, fills, check.steps.filter(s => s.action === 'fill' && s.soil).length, check.steps.filter(s => s.action === 'fill' && s.floor).length)
  if (caps.some(s => s.cap === 'trapdoor')) await supplyTrapdoors(ctx, caps.filter(s => s.cap === 'trapdoor').length)
  if (torches) {
    const t = await supplyTorches(bot, signal, log, Math.min(torches, 16)).catch(e => { checkAborted(signal); return 0 })
    if (typeof t !== 'number') notes.push(`torches: ${t.message}`)
  }
  const done: Record<string, number> = {}
  const failed: string[] = []
  const capped = new Map<string, { cells: FixStep['pos'][], kind: PlacedCap }>()
  // a block with nothing to place it against yet gets one more go at the end, once its neighbours are in
  const queue = [...check.steps]
  const first = queue.length
  for (let n = 0; n < queue.length; n++) {
    const s = queue[n]!
    checkAborted(signal)
    if (Date.now() > until) { notes.push(`session over after ${minutes} min`); break }
    try {
      if (s.action === 'fill') {
        const at = vec(bot, s.pos.x, s.pos.y, s.pos.z)
        const here = bot.blockAt(at) as unknown as { name: string, boundingBox: string } | null
        const t = here ? fillStepTarget({ name: here.name, solid: here.boundingBox === 'block' }, check.settings.clearFixtures) : 'place'
        // filled already (a neighbour's fill, a block it placed earlier) or not ours to break
        if (t === 'done' || t === 'skip') continue
        if (t === 'clear' && here) {
          await reachToDig(bot, at, signal, log)
          await equipFor(bot, here as never)
          await digBlock(bot, here as never, signal)
        }
        const f = pickFiller(carriedFillers(bot), { soil: !!s.soil, floor: !!s.floor })
        if (!f) { failed.push('out of filler blocks'); break }
        const r = await placeBlockState(bot, f, at, undefined, signal, { canDig: false })
        if (!r.ok) throw new Error(`placing ${f} at ${fmtPos(s.pos)} did not take`)
      } else if (s.action === 'torch') {
        if (/(^|_)torch$/.test(bot.blockAt(vec(bot, s.pos.x, s.pos.y, s.pos.z))?.name ?? '')) { done[s.technique] = (done[s.technique] ?? 0) + 1; continue }
        if (!bot.inventory.items().some(i => i.name === 'torch')) { failed.push('out of torches'); continue }
        await placeBlockState(bot, 'torch', vec(bot, s.pos.x, s.pos.y, s.pos.z), undefined, signal, { canDig: false })
      } else {
        const pick = capItem(bot, s.cap ?? 'block')
        if (!pick) { failed.push('nothing to cap with'); continue }
        await placeCap(bot, s.pos, pick.item, pick.kind, signal, (agent as Agent).canDig)
        if (s.mine) {
          const c = capped.get(s.mine) ?? { cells: [], kind: pick.kind }
          c.cells.push(s.pos)
          capped.set(s.mine, c)
        }
      }
      done[s.technique] = (done[s.technique] ?? 0) + 1
    } catch (e) {
      checkAborted(signal)
      if (e instanceof NotPlaceableYet && n < first) { queue.push(s); continue }
      const msg = (e as Error).message
      if (!failed.includes(msg)) failed.push(msg)
      log.debug('base safety: step failed', { at: fmtPos(s.pos), action: s.action, error: msg })
    }
  }
  // the mine remembers its cap, so its trips take it off and put it back
  for (const [id, c] of capped) {
    const m = getMines(agent as Agent).find(x => x.id === id)
    if (!m) continue
    const cap = { cells: [...(m.cap?.cells ?? []), ...c.cells].filter((p, i, a) => a.findIndex(q => q.x === p.x && q.y === p.y && q.z === p.z) === i), kind: c.kind, at: Date.now() }
    // an outside mine hugging the walls is closed for good when its own mine belongs inside (baseSafety.retireCloseMines)
    const retire = retireMine(m, true, bs)
    saveMine(agent as Agent, { ...m, cap, ...(retire ? { retired: { at: Date.now(), why: 'outside the walls and too close to them: capped, a new mine goes inside the base' } } : {}) })
    if (retire) notes.push(`retired ${id} (capped; the next mine goes inside the base)`)
  }
  const did = Object.entries(done).map(([t, n]) => `${t} ${n}`).join(', ')
  const after = checkBase(agent as Agent, bot)
  const left = typeof after === 'string' ? 0 : after.steps.length
  const msg = `${did ? `base safety: ${did}` : 'base safety: nothing placed'}${failed.length ? `; failed: ${failed.slice(0, 3).join('; ')}` : ''}${notes.length ? `; ${notes.join('; ')}` : ''}; ${left ? `${left} step${left === 1 ? '' : 's'} left` : 'nothing left'}`
  return did ? ok(msg, { done, left }) : fail(msg, { done, left })
}
