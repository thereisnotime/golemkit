import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  chooseMethod, creativeSettings, blockString, cellBlocks, mergeRuns, fillCommand, planCommands, noCommandRights, runCommands, FILL_MAX
} from '../src/skills/creative-build.ts'
import { findToggle, parseToggleValue } from '../src/core/toggles.ts'

/** An agent whose server answers each command with `reply(cmd)`. */
function fakeAgent (reply: (cmd: string) => string) {
  const ev = new EventEmitter()
  const sent: string[] = []
  return {
    sent,
    async command (c: string) { sent.push(c); setTimeout(() => ev.emit('serverMessage', reply(c)), 10); return true },
    on (name: string, fn: (t: string) => void) { ev.on(name, fn); return () => { ev.off(name, fn) } }
  } as any
}

const log: any = { info () {}, debug () {}, warn () {}, child () { return log } }

test('method: survival always by hand, creative follows the action, then the setting, auto = hand', () => {
  assert.equal(chooseMethod(false, 'commands', 'commands'), 'hand')
  assert.equal(chooseMethod(true, undefined, undefined), 'hand')
  assert.equal(chooseMethod(true, 'auto', 'commands'), 'commands')
  assert.equal(chooseMethod(true, 'hand', 'commands'), 'hand')
  assert.equal(chooseMethod(true, 'commands', 'hand'), 'commands')
  assert.equal(chooseMethod(true, undefined, 'auto'), 'hand')
  assert.deepEqual(creativeSettings({}), { method: 'auto', handDelayMs: 150 })
  assert.deepEqual(creativeSettings({ build: { creativeMethod: 'commands', handDelayMs: 0 } }), { method: 'commands', handDelayMs: 0 })
  assert.equal(creativeSettings({ build: { creativeMethod: 'nonsense' } }).method, 'auto')
})

test('toggles: build.creativeMethod and build.handDelayMs can be changed live', () => {
  const m = findToggle('build.creativeMethod')!
  assert.deepEqual(parseToggleValue(m, 'commands'), { ok: true, value: 'commands' })
  assert.equal(parseToggleValue(m, 'fast').ok, false)
  assert.deepEqual(parseToggleValue(findToggle('build.handDelayMs')!, '200'), { ok: true, value: 200 })
})

test('state strings: properties in brackets, none without', () => {
  assert.equal(blockString('cobblestone'), 'cobblestone')
  assert.equal(blockString('oak_stairs', { facing: 'north', half: 'bottom' }), 'oak_stairs[facing=north,half=bottom]')
  assert.equal(cellBlocks({ x: 0, y: 64, z: 0, state: { facing: 'south' } }, 'torch', 'attachment')[0]!.block, 'wall_torch[facing=south]', 'a facing torch is a wall torch')
  assert.equal(cellBlocks({ x: 0, y: 64, z: 0 }, 'torch', 'attachment')[0]!.block, 'torch')
})

test('doors get both halves, beds both parts along their facing; both go in late', () => {
  const door = cellBlocks({ x: 5, y: 64, z: 5, state: { facing: 'north', hinge: 'left' } }, 'spruce_door', 'door')
  assert.deepEqual(door.map(b => [b.y, b.block, b.late]), [
    [64, 'spruce_door[facing=north,hinge=left,half=lower]', true],
    [65, 'spruce_door[facing=north,hinge=left,half=upper]', true]
  ])
  const bed = cellBlocks({ x: 5, y: 64, z: 5, state: { facing: 'east' } }, 'white_bed', 'furnish')
  assert.deepEqual(bed.map(b => [b.x, b.z, b.block]), [[5, 5, 'white_bed[facing=east,part=foot]'], [6, 5, 'white_bed[facing=east,part=head]']])
  assert.equal(cellBlocks({ x: 0, y: 64, z: 0 }, 'cobblestone', 'block')[0]!.late, false)
})

test('run merging: a floor is one /fill, a wall with a gap two, single blocks /setblock', () => {
  const floor = []
  for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) floor.push({ x, y: 64, z, block: 'cobblestone' })
  assert.deepEqual(mergeRuns(floor).map(fillCommand), ['/fill 0 64 0 4 64 4 cobblestone'])
  const wall = []
  for (let x = 0; x < 5; x++) for (let y = 65; y <= 67; y++) if (!(x === 2 && y < 67)) wall.push({ x, y, z: 0, block: 'oak_planks' })
  const cmds = mergeRuns(wall).map(fillCommand)
  assert.equal(new Set(wall.map(b => `${b.x},${b.y}`)).size, 13)
  // the gap splits the bottom two rows; the top row is one run
  assert.ok(cmds.length <= 3, cmds.join(' ; '))
  const covered = new Set<string>()
  for (const b of mergeRuns(wall)) for (let x = b.x0; x <= b.x1; x++) for (let y = b.y0; y <= b.y1; y++) covered.add(`${x},${y}`)
  assert.equal(covered.size, 13)
  assert.ok(!covered.has('2,65') && !covered.has('2,66'))
  assert.equal(fillCommand(mergeRuns([{ x: 1, y: 2, z: 3, block: 'torch' }])[0]!), '/setblock 1 2 3 torch')
  // different blocks never merge
  assert.equal(mergeRuns([{ x: 0, y: 0, z: 0, block: 'a' }, { x: 1, y: 0, z: 0, block: 'b' }]).length, 2)
})

test('run merging: never over the /fill limit', () => {
  const big = []
  for (let x = 0; x < 64; x++) for (let z = 0; z < 64; z++) for (let y = 0; y < 10; y++) big.push({ x, y, z, block: 'stone' })
  const boxes = mergeRuns(big)
  for (const b of boxes) assert.ok((b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * (b.z1 - b.z0 + 1) <= FILL_MAX)
  assert.ok(boxes.length <= 2)
})

test('command plan: clear, dips, structure, attachments last', () => {
  const cmds = planCommands({
    clear: [{ x: 0, y: 65, z: 0 }],
    fills: [{ x: 0, y: 63, z: 0 }],
    blocks: [
      ...cellBlocks({ x: 1, y: 65, z: 0, state: { facing: 'south' } }, 'torch', 'attachment'),
      ...cellBlocks({ x: 0, y: 64, z: 0 }, 'cobblestone', 'block')
    ]
  })
  assert.deepEqual(cmds, ['/setblock 0 65 0 air', '/setblock 0 63 0 cobblestone', '/setblock 0 64 0 cobblestone', '/setblock 1 65 0 wall_torch[facing=south]'])
})

test('no op rights: detected from the reply to the first command, nothing more is sent', async () => {
  assert.ok(noCommandRights(['Unknown or incomplete command, see below for error', '...fill 0 64 0<--[HERE]']))
  assert.ok(noCommandRights(['You do not have permission to use this command']))
  assert.equal(noCommandRights(['Successfully filled 25 block(s)']), null)
  const agent = fakeAgent(() => 'Unknown or incomplete command, see below for error')
  const r = await runCommands(agent, ['/fill 0 0 0 1 1 1 air', '/setblock 0 0 0 stone'], new AbortController().signal, log, 500)
  assert.ok(r.noRights)
  assert.deepEqual(agent.sent, ['/fill 0 0 0 1 1 1 air'])
})

test('op: every command goes out, errors in replies are reported', async () => {
  const agent = fakeAgent(c => (c.includes('bad') ? 'Unknown block type \'bad\'' : 'Successfully filled 4 block(s)'))
  const ok = await runCommands(agent, ['/fill 0 0 0 1 1 1 air', '/setblock 0 0 0 stone'], new AbortController().signal, log, 500)
  assert.deepEqual([ok.ok, ok.sent, ok.errors], [true, 2, []])
  const bad = await runCommands(agent, ['/fill 0 0 0 1 1 1 air', '/setblock 0 0 0 bad'], new AbortController().signal, log, 500)
  assert.equal(bad.ok, false)
  assert.match(bad.errors[0]!, /Unknown block/)
})
