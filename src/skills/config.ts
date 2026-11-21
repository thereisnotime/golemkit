// In-game feature toggles: change bot settings live, no restart. Owners only.
//   !config_list   !config_get llm.listen   !config_set llm.listen all   !config_reset [key]
import { defineSkill, defineAction, z, noParams, ok, fail } from '../core/index.ts'
import type { ActionContext } from '../core/index.ts'

/** Players must be owners; brains (LLM etc.) can't change their own settings. */
function allowed (ctx: ActionContext): string | null {
  if (ctx.caller.kind === 'player') return ctx.agent.isOwner(ctx.caller.name) ? null : 'only my owners can change my settings'
  if (ctx.caller.kind === 'system') return null
  return 'settings can only be changed by an owner'
}

const fmt = (v: unknown) => Array.isArray(v) ? v.join(',') : v === undefined ? '(default)' : JSON.stringify(v)

const configList = defineAction({
  name: 'config_list',
  description: 'List the settings that can be changed in game (feature toggles) with their current values.',
  params: noParams,
  exclusive: false,
  run ({ agent }) {
    const rows = agent.listToggles()
    return ok(rows.map(r => `${r.key}=${fmt(r.value)}${r.overridden ? '*' : ''}`).join(' | ') + '  (* = changed in game)', rows.map(r => ({ key: r.key, value: r.value, overridden: r.overridden, description: r.def.description })))
  }
})

const configGet = defineAction({
  name: 'config_get',
  description: 'Show one setting, what it does and whether it was changed in game.',
  params: z.object({ key: z.string() }),
  exclusive: false,
  run ({ agent }, { key }) {
    const row = agent.listToggles().find(r => r.key === key)
    if (!row) return fail(`unknown setting ${key} (see config_list)`)
    return ok(`${key}=${fmt(row.value)}${row.overridden ? ' (changed in game)' : ''}: ${row.def.description}`)
  }
})

const configSet = defineAction({
  name: 'config_set',
  description: 'Change a setting live (owners only), e.g. config_set llm.listen all, config_set reflexes.retreatBelow 6. Persists until config_reset.',
  params: z.object({ key: z.string(), value: z.string().describe('new value; lists comma separated') }),
  exclusive: false,
  run (ctx, { key, value }) {
    const denied = allowed(ctx)
    if (denied) return fail(denied)
    const r = ctx.agent.setToggle(key, value)
    return r.ok ? ok(`${key} = ${fmt(r.value)} (live)`) : fail(r.error)
  }
})

const configReset = defineAction({
  name: 'config_reset',
  description: 'Undo in-game setting changes: one key, or all of them, back to the profile values (owners only).',
  params: z.object({ key: z.string().optional() }),
  exclusive: false,
  run (ctx, { key }) {
    const denied = allowed(ctx)
    if (denied) return fail(denied)
    const n = ctx.agent.resetToggle(key)
    return ok(n ? `reset ${n} setting${n === 1 ? '' : 's'}${key ? ` (${key})` : ''}` : 'nothing to reset')
  }
})

export const config = () => defineSkill({
  name: 'config',
  description: 'Feature toggles: change settings in game without a restart.',
  actions: [configList, configGet, configSet, configReset]
})
