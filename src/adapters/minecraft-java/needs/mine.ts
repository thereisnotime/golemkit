// Site check for its staircase mines (src/skills/stairMine.ts): water or lava in the first stair
// steps (flooded, unsafe) or the stairs filled in (gone). A bad mine is skipped; the next trip
// digs a new one, and a mine a player fixed is used again after the re-check.
import type { Bot } from 'mineflayer'
import type { Agent } from '../../../core/index.ts'
import type { SiteProbe, NpcContext } from '../../../brains/npc/index.ts'
import { getMines, mineEntranceLook, mineSiteVerdict } from '../../../skills/stairMine.ts'

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
      const look = mineEntranceLook(b, m)
      return look ? mineSiteVerdict(look) : null
    },
    onBad: () => 'the next trip digs a new one'
  }
}
