// Site checks for the Minecraft Java adapter: its farms (water and ice over the field, nothing
// left to till), the spawn bed (gone), its own and configured chests (gone) and home (in water
// or lava, buried). The verdicts are pure (src/skills/needPlan.ts); this file reads the blocks.
import type { Bot } from 'mineflayer'
import type { Agent, SiteRef, SiteVerdict } from '../../../core/index.ts'
import type { SiteProbe, NpcContext } from '../../../brains/npc/index.ts'
import { getFarms, saveFarm, type Farm } from '../../../skills/food.ts'
import { getHome, setPlace } from '../../../skills/navigation.ts'
import { getSpawn, spawnBedState } from '../../../skills/bed.ts'
import { ownChests, configuredChests } from '../../../skills/containers.ts'
import { vec } from '../../../skills/world.ts'
import { farmSiteVerdict, type FarmSiteCell } from '../../../skills/needPlan.ts'
import { mineSiteProbe } from './mine.ts'
import { readFarmCells } from '../../../skills/foodSources.ts'
import { farmRepairSettings } from '../../../skills/farmRepairPlan.ts'

const bot = (ctx: NpcContext) => ctx.bot as Bot
/** Sites further than this are not checked: too far to be loaded and seen properly. */
const CHECK_RANGE = 64

const farFrom = (b: Bot, p: { x: number, z: number }) => !b.entity || Math.hypot(b.entity.position.x - p.x, b.entity.position.z - p.z) > CHECK_RANGE
const dimOk = (b: Bot, dim?: string) => !dim || !b.game?.dimension || dim === b.game.dimension

/** The cells of a farm square as the site check sees them; null when not loaded. */
export function farmCells (b: Bot, f: { x: number, y: number, z: number, size: number }): Record<string, FarmSiteCell> | null {
  return readFarmCells(b, f)?.cells ?? null
}

function farmRef (f: Farm): SiteRef {
  return { kind: 'farm', id: f.name, pos: { x: f.x, y: f.y, z: f.z, ...(f.dim ? { dim: f.dim } : {}) }, label: `my farm ${f.name}`, data: { ...f } }
}

export function minecraftSites (agent: Agent): SiteProbe[] {
  const farm: SiteProbe = {
    kind: 'farm',
    list: () => getFarms(agent).map(farmRef),
    check (ctx, site) {
      const b = bot(ctx)
      const p = site.pos
      if (!p || !dimOk(b, p.dim) || farFrom(b, p) || typeof b.blockAt !== 'function') return null
      const size = typeof site.data?.size === 'number' ? site.data.size : 9
      const cells = farmCells(b, { x: p.x, y: p.y, z: p.z, size })
      const land = Array.isArray(site.data?.land) ? (site.data.land as unknown[]).filter((k): k is string => typeof k === 'string') : undefined
      return cells ? farmSiteVerdict(cells, land) : null
    },
    onBad (ctx, rec, replace) {
      if (!replace) return 'left on my list (sites.replace is off)'
      // drop it from the farms it tends; farm_setup's food sources then repair it (repair_farm) or
      // start a new one elsewhere, as farming.badFarm says
      agent.storage.set('farms', getFarms(agent).filter(f => f.name !== rec.id))
      setPlace(agent, rec.id, null)
      const mode = farmRepairSettings((agent.settings as { farming?: unknown }).farming).badFarm
      if (mode === 'off') return 'left it for the owners (farming.badFarm off)'
      if (mode === 'relocate') return 'dropped it, a new farm goes near home'
      return mode === 'repair' ? 'I will try to repair it' : 'I will repair it if that is a small job, else a new farm goes near home'
    },
    onRecovered (ctx, rec) {
      const f = rec.data as unknown as Farm | undefined
      if (!f || typeof f.x !== 'number' || getFarms(agent).some(x => x.name === rec.id)) return
      saveFarm(agent, { ...f, name: rec.id })
      setPlace(agent, rec.id, { x: f.x, y: f.y, z: f.z, ...(f.dim ? { dimension: f.dim } : {}) })
      return 'back on my list'
    }
  }

  const bed: SiteProbe = {
    kind: 'bed',
    list: () => {
      const s = getSpawn(agent)
      return s.status === 'set' && s.bed ? [{ kind: 'bed', id: `${s.bed.x},${s.bed.y},${s.bed.z}`, pos: { ...s.bed, ...(s.dim ? { dim: s.dim } : {}) }, label: 'my bed' }] : []
    },
    check (ctx, site) {
      const b = bot(ctx)
      if (!site.pos || farFrom(b, site.pos)) return null
      const st = spawnBedState(b, { status: 'set', bed: site.pos, ...(site.pos.dim ? { dim: site.pos.dim } : {}) } as ReturnType<typeof getSpawn>)
      return st === 'unknown' ? null : st === 'bed' ? { ok: true } : { ok: false, fault: 'gone', reason: 'the bed is gone' }
    },
    // keep_spawn_bed puts a new one down by home
    onBad: () => agent.getAction('place_bed') ? 'keep_spawn_bed makes a new one' : undefined
  }

  const chest: SiteProbe = {
    kind: 'chest',
    list: () => {
      const conf = configuredChests(agent).map(p => ({ ...p, configured: true }))
      const own = ownChests(agent).filter(p => !conf.some(c => c.x === p.x && c.y === p.y && c.z === p.z)).map(p => ({ ...p, configured: false }))
      return [...conf, ...own].map(p => ({ kind: 'chest', id: `${p.x},${p.y},${p.z}`, pos: { x: p.x, y: p.y, z: p.z }, label: p.configured ? 'the chest from my profile' : 'my chest', data: { configured: p.configured } }))
    },
    check (ctx, site) {
      const b = bot(ctx)
      if (!site.pos || farFrom(b, site.pos) || typeof b.blockAt !== 'function') return null
      const block = b.blockAt(vec(b, site.pos.x, site.pos.y, site.pos.z))
      if (!block) return null
      return /chest|barrel|shulker_box/.test(block.name) ? { ok: true } : { ok: false, fault: 'gone', reason: `there is ${block.name.replace(/_/g, ' ')} where it was` }
    },
    onBad: (ctx, rec) => rec.data?.configured ? 'it is in my profile, so I leave that to you' : 'deposit_when_full puts down a new one when it needs it'
  }

  const home: SiteProbe = {
    kind: 'home',
    list: () => {
      const h = getHome(agent)
      return h ? [{ kind: 'home', id: 'home', pos: { x: h.x, y: h.y, z: h.z, ...(h.dimension ? { dim: h.dimension } : {}) }, label: 'home' }] : []
    },
    check (ctx, site) {
      const b = bot(ctx)
      if (!site.pos || !dimOk(b, site.pos.dim) || farFrom(b, site.pos) || typeof b.blockAt !== 'function') return null
      const feet = b.blockAt(vec(b, Math.floor(site.pos.x), Math.floor(site.pos.y), Math.floor(site.pos.z)))
      const head = b.blockAt(vec(b, Math.floor(site.pos.x), Math.floor(site.pos.y) + 1, Math.floor(site.pos.z)))
      if (!feet || !head) return null
      if (/lava/.test(feet.name) || /lava/.test(head.name)) return { ok: false, fault: 'unsafe', reason: 'lava where home is' }
      if (feet.name === 'water' && head.name === 'water') return { ok: false, fault: 'flooded', reason: 'home is under water' }
      if (feet.boundingBox === 'block' && head.boundingBox === 'block') return { ok: false, fault: 'gone', reason: `home is buried in ${head.name.replace(/_/g, ' ')}` }
      return { ok: true }
    },
    // home is the owner's choice (set_home): tell, don't move it
    onBad: () => 'set_home somewhere else if it should move'
  }

  return [farm, bed, chest, home, mineSiteProbe(agent)]
}

/** Failures that say a site can't be reached: "couldn't get to farm:1" (farm_setup), tend_farm on a missing farm. */
export function siteFromFailure (behavior: string, message: string, ctx: NpcContext): { ref: SiteRef, verdict: SiteVerdict } | null {
  const m = /couldn'?t get to (farm:\d+)/i.exec(message)
  if (m) {
    const f = getFarms(ctx.agent).find(x => x.name === m[1])
    if (f) return { ref: farmRef(f), verdict: { ok: false, fault: 'unreachable', reason: `${behavior}: ${message.slice(0, 120)}` } }
  }
  return null
}
