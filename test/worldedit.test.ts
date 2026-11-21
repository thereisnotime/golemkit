// WorldEdit skill: reply parsing, the we_raw whitelist, block limits, protected areas,
// detection, and the actions against a fake agent that answers commands like a server would.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseWeReply, explainReply, detectFromSignals, detectFromProbe, checkRaw, validPattern, validSchemName, protectedOverlap, boxVolume, weSettings,
  worldedit, DEFAULT_MAX_BLOCKS
} from '../src/skills/worldedit.ts'
import { findToggle, parseToggleValue } from '../src/core/toggles.ts'
import { parseProfile } from '../src/core/profile.ts'
import type { ActionResult } from '../src/core/index.ts'

// ------------------------------------------------------------------ parsing

test('parseWeReply: block counts in the wordings WorldEdit 6/7 and FAWE use', () => {
  assert.equal(parseWeReply(['Operation completed (1,234 blocks affected).']).blocks, 1234)
  assert.equal(parseWeReply(['320 blocks have been changed.']).blocks, 320)
  assert.equal(parseWeReply(['45 block(s) have been replaced.']).blocks, 45)
  assert.equal(parseWeReply(['125 blocks were copied.']).blocks, 125)
  assert.equal(parseWeReply(['Undo successful. (64 blocks affected)']).blocks, 64)
  const r = parseWeReply(['First position set to (10, 64, -3) (125).'])
  assert.deepEqual(r.pos, { x: 10, y: 64, z: -3 })
  assert.equal(r.ok, true)
  const size = parseWeReply(['Type: cuboid', 'Offset: (-2, 0, -3)', 'Size: (5, 4, 7)', 'Cuboid distance: 4.0', '# of blocks: 140'])
  assert.deepEqual(size.size, [5, 4, 7])
  assert.deepEqual(size.offset, [-2, 0, -3])
  assert.equal(size.volume, 140)
  assert.equal(parseWeReply(['WorldEdit version 7.3.6+6892-1a4fa7b']).version, 'WorldEdit 7.3.6+6892-1a4fa7b')
  assert.equal(parseWeReply(['FastAsyncWorldEdit 2.12.3-SNAPSHOT-950']).version, 'FastAsyncWorldEdit 2.12.3-SNAPSHOT-950')
  const list = parseWeReply(['Available schematics (Filename: Format) [1/2]:', '- cottage.schem (sponge.3)', '- old_tower.schematic (mcedit)'])
  assert.deepEqual(list.files, ['cottage.schem', 'old_tower.schematic'])
  assert.equal(list.pages, 2)
})

test('parseWeReply: errors come back as failures with a kind', () => {
  const kinds: [string, string][] = [
    ["You don't have permission to do this.", 'permission'],
    ['You are not permitted to do that. Are you in the right mode?', 'permission'],
    ['Unknown or incomplete command, see below for error', 'unknown_command'],
    ['Unknown command. Type "/help" for help.', 'unknown_command'],
    ['Max blocks changed in an operation reached (10000).', 'too_big'],
    ['Make a region selection first.', 'no_selection'],
    ['Your clipboard is empty. Use //copy first.', 'empty_clipboard'],
    ["Does not match a valid block type: 'stonee'", 'bad_pattern'],
    ['Schematic house does not exist!', 'not_found'],
    ['That schematic already exists. Use the -f flag to overwrite it.', 'exists'],
    ['Nothing left to undo.', 'nothing'],
    ['Usage: //set <pattern>', 'usage']
  ]
  for (const [line, kind] of kinds) {
    const r = parseWeReply([line])
    assert.equal(r.kind, kind, line)
    assert.equal(r.ok, false, line)
    assert.ok(explainReply(r, 'x').startsWith('x: '))
  }
  assert.equal(parseWeReply([]).kind, 'silent')
  assert.equal(parseWeReply([]).ok, false)
})

// ------------------------------------------------------------------ safety

test('we_raw whitelist: allowed commands are normalised, the rest refused', () => {
  assert.deepEqual(checkRaw('//expand 5 up'), { ok: true, command: '//expand 5 up', kind: 'info', count: 1 })
  assert.deepEqual(checkRaw('stack 3 north'), { ok: true, command: '//stack 3 north', kind: 'stack', count: 3 })
  assert.equal(checkRaw('/smooth 2').command, '//smooth 2')
  for (const bad of ['//regen', '//butcher -a', '/we reload', '//schem delete house', '//generate stone x^2<10', '//limit -1', '//sphere stone 50', '//gmask', '//snapshot use x']) {
    assert.equal(checkRaw(bad).ok, false, bad)
  }
  assert.equal(checkRaw('//expand 5 up; /op me').ok, false, 'no ; or /')
  assert.equal(checkRaw('//set "stone"').ok, false)
  assert.equal(validPattern('50%stone,50%cobblestone'), true)
  assert.equal(validPattern('oak_stairs[facing=north,half=top]'), true)
  assert.equal(validPattern('stone /op'), false)
  assert.equal(validPattern('../x'), false)
  assert.equal(validSchemName('cottage'), true)
  assert.equal(validSchemName('cottage.schem'), true)
  assert.equal(validSchemName('../etc/passwd'), false)
  assert.equal(validSchemName('a b'), false)
})

test('limits and protected areas', () => {
  assert.equal(boxVolume({ x: 0, y: 0, z: 0 }, { x: 9, y: 4, z: -9 }), 500)
  assert.equal(weSettings({}).maxBlocks, DEFAULT_MAX_BLOCKS)
  assert.equal(weSettings({ worldedit: { maxBlocks: 1000 } }).maxBlocks, 1000)
  assert.equal(weSettings({ worldedit: true }).enabled, true)
  assert.equal(weSettings({}).ownersOnly, true)
  const box = { min: { x: 100, y: 60, z: 100 }, max: { x: 110, y: 70, z: 110 } }
  assert.equal(protectedOverlap(box, [], null, 24), null)
  assert.match(protectedOverlap(box, [{ x: 125, y: 64, z: 105 }], null, 24)!, /protected area around 125 64 105/)
  assert.equal(protectedOverlap(box, [{ x: 200, y: 64, z: 105 }], null, 24), null)
  assert.match(protectedOverlap(box, [], { x: 130, y: 64, z: 130 }, 24)!, /spawn area/)
  // live toggle and profile key
  const t = findToggle('worldedit.maxBlocks')!
  assert.deepEqual(parseToggleValue(t, '20000'), { ok: true, value: 20000 })
  assert.equal(parseToggleValue(t, '0').ok, false)
  assert.deepEqual(parseToggleValue(findToggle('worldedit.enabled')!, 'on'), { ok: true, value: true })
  assert.deepEqual(parseProfile('variant: buddy\nworldedit: true\n').options.settings?.worldedit ?? parseProfile('variant: buddy\nworldedit: true\n').profile.worldedit, { enabled: true })
})

test('detection: settings, channels, registries, then the probe', () => {
  assert.equal(detectFromSignals({ forced: true, channels: [], namespaces: [] }).available, true)
  assert.equal(detectFromSignals({ forced: false, channels: ['worldedit:cui'], namespaces: [] }).available, false)
  assert.match(detectFromSignals({ channels: ['create:main', 'worldedit:cui'], namespaces: [] }).how, /worldedit:cui/)
  assert.equal(detectFromSignals({ channels: [], namespaces: ['minecraft', 'worldedit'] }).available, true)
  // mc02 today: Create and Ars channels, nothing from WorldEdit -> ask the server
  const mc02 = detectFromSignals({ channels: ['create:main', 'ars_nouveau:main', 'curios:main'], namespaces: ['minecraft', 'create'] })
  assert.equal(mc02.available, null)
  const probe = detectFromProbe(parseWeReply(['Unknown or incomplete command, see below for error', '/we version<--[HERE]']), mc02.how)
  assert.equal(probe.available, false)
  assert.match(probe.how, /no WorldEdit channels.*unknown command/)
  assert.equal(detectFromProbe(parseWeReply(['WorldEdit version 7.3.6']), 'x').available, true)
  assert.equal(detectFromProbe(parseWeReply([]), 'x').available, false)
  assert.equal(detectFromProbe(parseWeReply(["I'm sorry, but you do not have permission to perform this command."]), 'x').available, false)
})

// ------------------------------------------------------------------ actions with a fake agent

/** A fake agent and bot. `server` answers each command with reply lines (or none). */
function fake (server: (cmd: string) => string[], opts: { settings?: Record<string, unknown>, owners?: string[], zones?: { x: number, y: number, z: number }[], spawn?: { x: number, y: number, z: number } } = {}) {
  const ee = new EventEmitter()
  const sent: string[] = []
  const logs: string[] = []
  const log: any = { info: (m: string, f?: unknown) => logs.push(`${m} ${JSON.stringify(f ?? {})}`), debug () {}, warn () {}, error () {} }
  log.child = () => log
  const owners = opts.owners ?? ['boss']
  const agent: any = {
    settings: opts.settings ?? {},
    owners,
    server: { host: 'nowhere.invalid', port: 1 },
    dataDir: mkdtempSync(join(tmpdir(), 'we-')),
    protectedAreas: { zones: opts.zones ?? [] },
    isOwner: (p: string) => owners.includes(p.toLowerCase()),
    on: (ev: string, fn: (...a: any[]) => void) => { ee.on(ev, fn); return () => ee.off(ev, fn) },
    off: (ev: string, fn: (...a: any[]) => void) => ee.off(ev, fn),
    async command (cmd: string) {
      sent.push(cmd)
      setTimeout(() => { for (const l of server(cmd)) ee.emit('serverMessage', l) }, 5)
      return true
    }
  }
  const bot: any = {
    entity: { position: { x: 500.5, y: 64, z: 500.5 } },
    players: { boss: { entity: { position: { x: 500.5, y: 64, z: 500.5 } } } },
    spawnPoint: opts.spawn ?? null,
    _client: new EventEmitter()
  }
  const skill = worldedit()
  skill.setup!(agent, bot)
  const run = async (name: string, params: Record<string, unknown>, caller: any = { kind: 'player', name: 'boss' }) => {
    const def = skill.actions!.find(a => a.name === name)!
    return await def.run({ agent, bot, caller, player: caller.kind === 'player' ? caller.name : undefined, signal: new AbortController().signal, log } as any, def.params.parse(params)) as ActionResult
  }
  return { agent, bot, sent, logs, run }
}

/** A WorldEdit 7 server that knows //pos1, //pos2, //set, //size -c, //paste, //schem list/load. */
function weServer (cmd: string): string[] {
  if (cmd === '/we version') return ['WorldEdit version 7.3.6']
  let m = /^\/\/pos([12]) (-?\d+),(-?\d+),(-?\d+)$/.exec(cmd)
  if (m) return [`${m[1] === '1' ? 'First' : 'Second'} position set to (${m[2]}, ${m[3]}, ${m[4]}).`]
  if (cmd.startsWith('//set ')) return ['Operation completed (75 blocks affected).']
  if (cmd === '//size') return ['Make a region selection first.']
  if (cmd === '//size -c') return ['Offset: (-1, 0, -1)', 'Size: (3, 3, 3)', '# of blocks: 27']
  if (cmd.startsWith('//paste')) return ['The clipboard has been pasted at (500, 64, 500)']
  if (cmd === '//schem list') return ['Available schematics (Filename: Format) [1/1]:', '- well.schem (sponge.3)']
  m = /^\/\/schem load (\S+)$/.exec(cmd)
  if (m) return m[1] === 'well' ? ['well loaded. Paste it with //paste'] : [`Schematic ${m[1]} does not exist!`]
  return ['Unknown or incomplete command, see below for error']
}

test('actions: not available on a server without WorldEdit', async () => {
  const f = fake(() => ['Unknown or incomplete command, see below for error'])
  const s = await f.run('we_status', {})
  assert.equal(s.ok, false)
  assert.match(s.message, /^WorldEdit not available: no WorldEdit channels or registry entries; \/we version: unknown command/)
  assert.deepEqual(f.sent, ['/we version'])
  const set = await f.run('we_set', { pattern: 'stone' })
  assert.equal(set.ok, false)
  assert.match(set.message, /not available/)
  assert.deepEqual(f.sent, ['/we version'], 'detection is cached, nothing else sent')
})

/** What mc02 answered on 2026-11-21: WorldEdit 7.3.8 for NeoForge is installed, the bot may not use it. */
const MC02_VERSION = ['WorldEdit version (unknown)', 'https://github.com/EngineHub/WorldEdit/', '------------------ Platforms ------------------\n* Forge-Official(7.3.8+6939-7d32b45)',
  '---------------- Capabilities ----------------\nGAME_HOOKS: Forge-Official\nUSER_COMMANDS: Forge-Official\nWORLD_EDITING: Forge-Official']

test('actions: installed but no permission (mc02): not available, with the reason', async () => {
  assert.equal(parseWeReply(MC02_VERSION).version, 'WorldEdit 7.3.8+6939-7d32b45')
  const f = fake(cmd => (cmd === '/we version' ? MC02_VERSION : ['Unknown or incomplete command, see below for error', `${cmd.slice(1)}<--[HERE]`]))
  const s = await f.run('we_status', {})
  assert.equal(s.ok, false)
  assert.match(s.message, /not available: no WorldEdit channels or registry entries; \/we version answered WorldEdit 7\.3\.8\+6939-7d32b45, but I have no permission for its commands/)
  assert.deepEqual(f.sent, ['/we version', '//size'])
})

test('actions: select then set sends the commands and reports the server\'s count', async () => {
  const f = fake(weServer)
  const sel = await f.run('we_select', { x1: 500, y1: 64, z1: 500, x2: 504, y2: 66, z2: 504 })
  assert.equal(sel.ok, true, sel.message)
  assert.match(sel.message, /75 blocks/)
  const set = await f.run('we_set', { pattern: 'stone_bricks' })
  assert.equal(set.ok, true, set.message)
  assert.equal(set.message, 'set 75 blocks with stone_bricks')
  assert.deepEqual(f.sent, ['/we version', '//size', '//pos1 500,64,500', '//pos2 504,66,504', '//set stone_bricks'])
  assert.ok(f.logs.some(l => l.startsWith('worldedit') && l.includes('//set stone_bricks')), 'commands are logged')
})

test('actions: owners only, block limit, protected areas, bad patterns, whitelist', async () => {
  const f = fake(weServer, { settings: { worldedit: { maxBlocks: 50 } }, zones: [{ x: 520, y: 64, z: 500 }] })
  const stranger = await f.run('we_status', {}, { kind: 'player', name: 'stranger' })
  assert.equal(stranger.ok, true, 'status is for anyone')
  assert.match((await f.run('we_set', { pattern: 'stone' }, { kind: 'player', name: 'stranger' })).message, /only my owners/)
  assert.match((await f.run('we_set', { pattern: 'stone' })).message, /select a region with we_select first/)
  await f.run('we_select', { x1: 500, y1: 64, z1: 500, x2: 504, y2: 66, z2: 504 })
  const big = await f.run('we_set', { pattern: 'stone' })
  assert.match(big.message, /75 blocks is over my WorldEdit limit of 50/)
  f.agent.settings = { worldedit: { maxBlocks: 1000 } }
  const prot = await f.run('we_set', { pattern: 'stone' })
  assert.match(prot.message, /protected area around 520 64 500/)
  const allowed = await f.run('we_set', { pattern: 'stone', protected_ok: true })
  assert.equal(allowed.ok, true, 'an owner may allow it')
  assert.match((await f.run('we_set', { pattern: 'stone /op me' })).message, /isn't a block pattern/)
  assert.match((await f.run('we_raw', { command: '//regen' })).message, /isn't on the whitelist/)
  assert.ok(!f.sent.some(c => c.includes('regen') || c.includes('/op')), 'refused commands are never sent')
})

test('actions: server errors are reported truthfully', async () => {
  const f = fake(cmd => (cmd === '/we version' ? ['WorldEdit version 7.3.6'] : cmd === '//size' ? ['Make a region selection first.'] : cmd.startsWith('//pos') ? [`First position set to (0, 0, 0).`] : ["You don't have permission to do this."]), { settings: { worldedit: { maxBlocks: 1000 } } })
  await f.run('we_select', { x1: 0, y1: 0, z1: 0, x2: 1, y2: 1, z2: 1 })
  const r = await f.run('we_set', { pattern: 'stone' })
  assert.equal(r.ok, false)
  assert.match(r.message, /don't have permission/)
  const silent = fake(cmd => (cmd === '/we version' ? ['WorldEdit version 7.3.6'] : cmd === '//size' ? ['Make a region selection first.'] : []), { settings: { worldedit: { replyMs: 300 } } })
  const u = await silent.run('we_undo', {})
  assert.equal(u.ok, false)
  assert.match(u.message, /no reply from WorldEdit/)
})

test('we_build: pastes a schematic the server has, falls back to a normal build otherwise', async () => {
  const f = fake(weServer)
  const r = await f.run('we_build', { template: 'small_house', schematic: 'well', fallback: false })
  assert.equal(r.ok, true, r.message)
  assert.match(r.message, /built small_house with WorldEdit from the server's well.schem/)
  assert.deepEqual(f.sent.slice(-4), ['//schem list', '//schem load well', '//size -c', '//paste -a'])
  assert.deepEqual(f.sent.slice(0, 2), ['/we version', '//size'])
  const g = fake(weServer)
  const r2 = await g.run('we_build', { template: 'cottage', fallback: false })
  assert.equal(r2.ok, false)
  assert.match(r2.message, /no WorldEdit schematic named cottage.*can't upload one; not building it normally/)
  const h = fake(() => ['Unknown or incomplete command, see below for error'])
  const r3 = await h.run('we_build', { template: 'cottage', fallback: false })
  assert.match(r3.message, /WorldEdit isn't available/)
})

test('settings: worldedit.enabled forces it on without asking the server', async () => {
  const f = fake(weServer, { settings: { worldedit: { enabled: true } } })
  const s = await f.run('we_status', {})
  assert.equal(s.ok, true)
  assert.match(s.message, /forced on/)
  assert.deepEqual(f.sent, [])
})
