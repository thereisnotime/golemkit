// Site check for its staircase mines (src/skills/stairMine.ts): water or lava in the first stair
// steps (flooded, unsafe), the stairs filled in (gone), or an uncapped entrance too close to the base
// walls (unsafe; base safety caps it). A bad mine is skipped; the next trip
// digs a new one, and a mine a player fixed is used again after the re-check.
import type { Bot } from 'mineflayer'
import type { Agent } from '../../../core/index.ts'
import type { SiteProbe, NpcContext } from '../../../brains/npc/index.ts'
import { getMines, mineEntranceLook, mineSiteVerdict, mineNearBase } from '../../../skills/stairMine.ts'

const bot = (ctx: NpcContext) => ctx.bot as Bot
const CHECK_RANGE = 48

export function mineSiteProbe (agent: Agent): SiteProbe {
  return {
    kind: 'mine',
    list: () => getMines(agent).map(m => ({ kind: 'mine', id: m.id, pos: { ...m.entrance, ...(m.dim ? { dim: m.dim } : {}) }, label: `my mine ${m.id}` })),
    check (ctx, site) {
      const b = bot(ctx)
      const m = getMines(agent).find(x => x.id === site.id)
      if (!m || !b.entity || typeof b.blockAt !== 'function') return null
      if (m.dim && b.game?.dimension && m.dim !== b.game.dimension) return null
      if (Math.hypot(b.entity.position.x - m.entrance.x, b.entity.position.z - m.entrance.z) > CHECK_RANGE) return null
      // retired (capped by base safety, no more trips): nothing to judge, and not "unsafe" for ever
      if (m.retired) return { ok: true, note: `retired: ${m.retired.why}` }
      // an open hole next to (or inside) the base walls: a way under them for mobs (baseSafety.mineClearance)
      const near = mineNearBase(agent, m.entrance)
      if (near && !m.cap) return { ok: false, fault: 'unsafe', reason: `its entrance is ${near} and not capped` }
      const look = mineEntranceLook(b, m)
      return look ? mineSiteVerdict(look) : null
    },
    onBad: () => 'the next trip digs a new one'
  }
}
