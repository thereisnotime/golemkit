// Water bucket reflexes (combat.waterClutch): the MLG clutch against fall damage and putting out
// fire. Decisions are pure (techniques.ts); the reflexes brain watches every physics tick and
// starts water_bucket, which drives the bucket and scoops the water back up afterwards.
import type { Bot } from 'mineflayer'
import { defineAction, z, ok, fail, sleep, checkAborted } from '../core/index.ts'
import { clutchDecision, extinguishDecision, fallDamage } from './techniques.ts'

const SOFT = /^(water|bubble_column|slime_block|powder_snow|cobweb|ladder|vine|scaffolding|twisting_vines|weeping_vines|hay_block|honey_block)$/

/** The block the bot would land on (scanning down up to 64 blocks): its top y and whether it breaks the fall. */
export function landing (bot: Bot): { groundY: number, soft: boolean } | null {
  const p = bot.entity.position.floored()
  for (let dy = 0; dy <= 64; dy++) {
    const b = bot.blockAt(p.offset(0, -dy, 0))
    if (!b) return null
    if (SOFT.test(b.name) || b.name === 'lava') return { groundY: b.position.y + (b.name === 'lava' ? 0 : 1), soft: b.name !== 'lava' && b.name !== 'hay_block' }
    if (b.boundingBox === 'block') return { groundY: b.position.y + 1, soft: false }
  }
  return null
}

export function hasWaterBucket (bot: Bot): boolean {
  return bot.inventory.items().some(i => i.name === 'water_bucket')
}

/** Burning: entity flag bit 0 (shared_flags). */
export function burning (bot: Bot): boolean {
  const f = ((bot.entity as any)?.metadata as unknown[] | undefined)?.[0]
  return typeof f === 'number' && (f & 1) === 1
}

function featherFalling (bot: Bot): number {
  const boots = bot.inventory.slots[8] as any
  return ((boots?.enchants ?? []) as { name: string, lvl: number }[]).find(e => e.name === 'feather_falling')?.lvl ?? 0
}

function feetBlock (bot: Bot): any {
  return bot.blockAt(bot.entity.position.floored())
}

/** What the fall watcher needs to decide (pure inputs for clutchDecision). */
export function clutchInputs (bot: Bot, fallStartY: number, enabled: boolean) {
  const land = landing(bot)
  return clutchDecision({
    enabled,
    hasBucket: hasWaterBucket(bot),
    dimension: String((bot.game as any).dimension ?? ''),
    fallStartY,
    y: bot.entity.position.y,
    velY: bot.entity.velocity.y,
    groundY: land?.groundY ?? null,
    landingSoft: land?.soft ?? false,
    health: bot.health,
    featherFalling: featherFalling(bot)
  })
}

export function extinguishInputs (bot: Bot, enabled: boolean): boolean {
  const feet = feetBlock(bot)
  const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
  return extinguishDecision({
    enabled,
    burning: burning(bot),
    inWater: !!feet && /water|bubble_column/.test(feet.name),
    inLava: !!feet && feet.name === 'lava',
    hasBucket: hasWaterBucket(bot),
    dimension: String((bot.game as any).dimension ?? ''),
    solidBelow: below?.boundingBox === 'block'
  })
}

async function scoop (bot: Bot): Promise<boolean> {
  const bucket = bot.inventory.items().find(i => i.name === 'bucket')
  if (!bucket) return false
  for (let i = 0; i < 4; i++) {
    const p = bot.entity.position.floored()
    const src = [p, p.offset(0, -1, 0)].map(q => bot.blockAt(q)).find(b => b?.name === 'water' && (b.metadata === 0 || (b as any).getProperties?.().level === 0))
    if (!src) return false
    await bot.equip(bucket, 'hand').catch(() => {})
    await bot.look(bot.entity.yaw, -Math.PI / 2, true)
    await sleep(60)
    bot.activateItem()
    await sleep(150)
    if (bot.inventory.items().some(x => x.name === 'water_bucket')) return true
  }
  return false
}

export const waterBucket = defineAction({
  name: 'water_bucket',
  capabilities: ['place', 'inventory'],
  description: 'Use a water bucket: land a long fall in water placed just before the ground, or put out fire, then scoop the water back up (used by reflexes).',
  params: z.object({
    reason: z.enum(['fall', 'fire']),
    fallStartY: z.number().optional().describe('height the fall started at (fall)')
  }),
  internal: true,
  async run ({ bot, signal }, { reason, fallStartY }) {
    const before = bot.heldItem
    const bucket = () => bot.inventory.items().find(i => i.name === 'water_bucket')
    if (!bucket()) return fail('no water bucket')
    try {
      if (reason === 'fire') {
        await bot.equip(bucket()!, 'hand')
        await bot.look(bot.entity.yaw, -Math.PI / 2, true)
        await sleep(60, signal)
        bot.activateItem()
        await sleep(300, signal)
        const wet = await scoop(bot)
        return burning(bot) ? fail('still burning') : ok(`put the fire out${wet ? '' : ' (left the water)'}`)
      }
      const start = fallStartY ?? bot.entity.position.y
      let placed = false
      let ready = false
      const until = Date.now() + 8000
      while (Date.now() < until && !bot.entity.onGround) {
        checkAborted(signal)
        const feet = feetBlock(bot)
        if (feet && /water|bubble_column/.test(feet.name)) break
        const d = clutchInputs(bot, start, true)
        if (d.act === 'none' && !ready) return ok('no damaging fall after all')
        if (!ready) {
          await bot.equip(bucket()!, 'hand')
          ready = true
        }
        await bot.look(bot.entity.yaw, -Math.PI / 2, true)
        if (d.act === 'place') {
          bot.activateItem()
          placed = true
          break
        }
        await new Promise<void>(resolve => bot.once('physicsTick', () => resolve()))
      }
      if (!placed) return bot.entity.onGround ? fail('landed before the water went down') : ok('landed in water')
      // wait to land in it, then take it back
      const land = Date.now() + 2500
      while (Date.now() < land && !bot.entity.onGround && !(feetBlock(bot)?.name === 'water')) await sleep(50, signal)
      await sleep(250, signal)
      const wet = await scoop(bot)
      const dmg = fallDamage(start - bot.entity.position.y)
      return ok(`water bucket clutch from ${Math.round(start - bot.entity.position.y)} blocks (would have taken ${dmg})${wet ? '' : ', water left behind'}`)
    } finally {
      if (before && bot.heldItem?.name !== before.name) {
        const it = bot.inventory.items().find(i => i.name === before.name)
        if (it) await bot.equip(it, 'hand').catch(() => {})
      }
    }
  }
})
