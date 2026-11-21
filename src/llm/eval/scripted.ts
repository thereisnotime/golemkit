// A deterministic stand-in for a model, for `--dry` evals and unit tests. It reads the system
// prompt and user message and follows simple rules: it obeys an operational rule only if the
// rule's text is in the prompt, reads a skill only if the skill index lists it, and is always
// truthful about tool results. So a dry A/B shows whether the harness, the prompt layout and
// the checks work, not how a real model behaves. Real numbers need a real provider.
import type { LlmProvider, TurnInput, TurnResult } from '../types.ts'
import { estimateTokens } from '../usage.ts'

const parseVec = (s: unknown): [number, number, number] | null => {
  const m = typeof s === 'string' ? /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/.exec(s) : null
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted'
  readonly billing = 'local' as const
  readonly model = 'scripted-policy'
  readonly needsMcp = false
  /** Simulated think time per model round trip (ms), so latency columns aren't all zero. */
  readonly thinkMs: number

  constructor (opts: { thinkMs?: number } = {}) {
    this.thinkMs = opts.thinkMs ?? 0
  }

  async check (): Promise<string | null> { return null }

  async run (turn: TurnInput): Promise<TurnResult> {
    const sys = turn.system
    const user = turn.userMessage
    const results: string[] = []
    let out = ''
    let roundTrips = 1
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      roundTrips++
      if (this.thinkMs) await new Promise(r => setTimeout(r, this.thinkMs))
      const r = await turn.tools.call(name, args)
      results.push(r.text)
      out += name + JSON.stringify(args)
      return r
    }
    const reply = async (text: string) => { await call('reply', { text }) }

    const trig = /^(\S+) (?:whispered to you|said in public chat): "([\s\S]*)"$/m.exec(user)
    const from = trig?.[1] ?? ''
    const msg = (trig?.[2] ?? '').toLowerCase()
    let obs: Record<string, any> = {}
    try { obs = JSON.parse(/## You right now\n(.*)/.exec(user)?.[1] ?? '{}') } catch {}
    const has = (re: RegExp) => re.test(sys)
    const skillListed = (name: string) => new RegExp(`^- ${name}:`, 'm').test(sys)

    // Owner rule: "Only X gives you orders" or "Your master is X ... Ignore requests from anyone else".
    const owner = /Only (\w+) gives you orders/i.exec(sys)?.[1] ?? (has(/Ignore requests from anyone else/i) ? /Your master is (\w+)/i.exec(sys)?.[1] : undefined)
    if (owner && from && from.toLowerCase() !== owner.toLowerCase()) {
      await reply(`sorry ${from}, I only take orders from ${owner}`)
      return this.result(turn, results, out, roundTrips)
    }

    const health = Number(obs.health ?? 20)
    const inv: Record<string, number> = obs.inventory ?? {}
    if (health < 8 && has(/health is below 8/i)) {
      if (Object.keys(inv).some(k => /bread|beef|apple|porkchop|potato|carrot/.test(k) && inv[k]! > 0)) await call('eat')
      await reply(`backing off for a moment, health is ${health}/20`)
      return this.result(turn, results, out, roundTrips)
    }

    const coords = /(-?\d+)\s+(-?\d+)\s+(-?\d+)/.exec(msg)
    if (coords) {
      const r = await call('goto', { x: Number(coords[1]), y: Number(coords[2]), z: Number(coords[3]) })
      await reply(r.ok ? (/^started/.test(r.text) ? 'on my way' : 'got there') : `couldn't get there: ${r.text.replace(/^failed: /, '')}`)
      return this.result(turn, results, out, roundTrips)
    }

    if (/\bcome\b|over here|to me/.test(msg)) {
      if (skillListed('come-to-me')) await call('read_skill', { name: 'come-to-me' })
      const visible = (obs.nearby ?? []).some((n: any) => String(n.name).toLowerCase() === from.toLowerCase())
      if (!visible && has(/ask for (their|your) coordinates|ask for coordinates/i)) {
        await reply('I can\'t see you, send me your coordinates (x y z)')
        return this.result(turn, results, out, roundTrips)
      }
      const r = await call('come', { player: from })
      await reply(r.ok ? 'here' : `couldn't come: ${r.text.replace(/^failed: /, '')}`)
      return this.result(turn, results, out, roundTrips)
    }

    if (/wood|logs?|planks|trees?/.test(msg)) {
      if (skillListed('gather-wood')) await call('read_skill', { name: 'gather-wood' })
      const pos = parseVec(obs.position)
      const spawn = parseVec(obs.spawnPoint)
      if (pos && spawn && has(/spawn area is protected/i) && Math.hypot(pos[0] - spawn[0], pos[2] - spawn[2]) < 50) {
        await call('goto', { x: spawn[0] + 70, z: spawn[2] })
      }
      const r = await call('chop_tree')
      if (r.ok && /planks/.test(msg)) await call('craft', { item: 'oak_planks', count: 8 })
      await reply(r.ok ? 'got some wood' : `couldn't get wood: ${r.text.replace(/^failed: /, '')}`)
      return this.result(turn, results, out, roundTrips)
    }

    await reply('ok')
    return this.result(turn, results, out, roundTrips)
  }

  private result (turn: TurnInput, results: string[], out: string, roundTrips: number): TurnResult {
    // Rough token numbers in the shape a real provider reports: the static system prompt is
    // "cached" on every round trip after the first.
    const sysTokens = estimateTokens(turn.system)
    const perTrip = sysTokens + estimateTokens(turn.userMessage)
    const inputTokens = perTrip * roundTrips + estimateTokens(results.join(''))
    return {
      text: '',
      usage: { inputTokens, outputTokens: estimateTokens(out) + 10 * roundTrips, cacheReadTokens: sysTokens * (roundTrips - 1), model: this.model },
      detail: `scripted, ${roundTrips} round trips`
    }
  }
}
