import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseIntent, addressed, leadingCount, normalizeItem, DEFAULT_THRESHOLD } from '../src/brains/intents/parse.ts'

const ctx = { speaker: 'Tester' }

// [phrase, intent, args subset] ; intent null = must not trigger (no intent, or below threshold)
const CASES: [string, string | null, Record<string, unknown>?][] = [
  // follow
  ['follow me', 'follow', { player: 'Tester' }],
  ['Follow me!', 'follow', { player: 'Tester' }],
  ['can you follow me?', 'follow', { player: 'Tester' }],
  ['please follow me around', 'follow', { player: 'Tester' }],
  ['come with me', 'follow', { player: 'Tester' }],
  ['tag along', 'follow', {}],
  ['stick with us', 'follow', { player: 'Tester' }],
  ['follow steve', 'follow', { player: 'steve' }],
  ['follow me at 5 blocks', 'follow', { player: 'Tester', distance: 5 }],
  ['stop following me', 'unfollow'],
  ["don't follow me", 'unfollow'],
  ['leave me alone', 'unfollow'],
  // come
  ['come here', 'come', { player: 'Tester' }],
  ['come here please', 'come', { player: 'Tester' }],
  ['get over here', 'come'],
  ['come back', 'come'],
  ['over here!', 'come'],
  ['could you come to me', 'come'],
  // home and places
  ['go home', 'go_home'],
  ['head back home', 'go_home'],
  ['return to base', 'go_home'],
  ['go to the farm', 'goto', { place: 'farm' }],
  ['go to farm:1', 'goto', { place: 'farm:1' }],
  ['go to 100 64 -20', 'goto', { x: 100, y: 64, z: -20 }],
  ['walk to 100 -20', 'goto', { x: 100, z: -20 }],
  ['go there', 'goto', { at: 'speaker' }],
  ['go to steve', 'goto', { place: 'steve' }],
  ['set home', 'set_home', {}],
  ['set home here', 'set_home', { at: 'speaker' }],
  ['this is your home', 'set_home', { at: 'speaker' }],
  ['remember this place as the mine', 'remember_place', { name: 'mine', at: 'speaker' }],
  ['save this spot as wheat field', 'remember_place', { name: 'wheat_field' }],
  // guard
  ['guard me', 'guard', { target: 'player', player: 'Tester' }],
  ['protect me', 'guard', { target: 'player' }],
  ['be my bodyguard', 'guard', { target: 'player' }],
  ['watch my back', 'guard', { target: 'player' }],
  ['guard here', 'guard', { target: 'here' }],
  ['defend this area', 'guard', { target: 'here' }],
  ['guard the farm', 'guard', { target: 'place', place: 'farm' }],
  ['stop guarding', 'unguard'],
  ['stand down', 'unguard'],
  // stop
  ['stop', 'stop'],
  ['STOP!!', 'stop'],
  ['cancel that', 'stop'],
  ['never mind', 'stop'],
  ['stay here', 'stop', { stay: true }],
  ['wait', 'stop'],
  // behaviours
  ['start farming', 'behavior_on', { activity: 'farming' }],
  ['keep chopping', 'behavior_on', { activity: 'chopping' }],
  ['go exploring', 'behavior_on', { activity: 'exploring' }],
  ['stop chopping', 'behavior_off', { activity: 'chopping' }],
  ['stop farming for now', 'behavior_off', { activity: 'farming' }],
  ['turn on keep_fed', 'behavior_on', { behavior: 'keep_fed' }],
  ['disarm farm_loop', 'behavior_off', { behavior: 'farm_loop' }],
  // farm
  ['farm the wheat', 'farm', { crop: 'wheat' }],
  ['harvest the crops', 'farm', { crop: 'crops' }],
  ['farm at farm:1', 'farm', { place: 'farm:1' }],
  ['make a farm', 'farm', { create: true }],
  ['start a farm here', 'farm', { create: true, at: 'speaker' }],
  // wood
  ['chop some wood', 'chop', { unit: 'log' }],
  ['get wood', 'chop', { unit: 'log' }],
  ['chop wood', 'chop', {}],
  ['chop a tree', 'chop', { count: 1, unit: 'tree' }],
  ['chop down three trees', 'chop', { count: 3, unit: 'tree' }],
  ['get 20 logs', 'chop', { count: 20, unit: 'log' }],
  ['gather a stack of wood', 'chop', { count: 64, unit: 'log' }],
  ['get me some planks', 'chop', { unit: 'planks' }],
  ['get 16 oak logs', 'chop', { count: 16, unit: 'log', wood: 'oak' }],
  // collect / mine
  ['get 64 cobblestone', 'collect', { item: 'cobblestone', count: 64 }],
  ['get a stack of cobble', 'collect', { item: 'cobblestone', count: 64 }],
  ['mine 10 iron', 'collect', { item: 'iron_ore', count: 10 }],
  ['mine ten iron', 'collect', { item: 'iron_ore', count: 10 }],
  ['dig some dirt', 'collect', { item: 'dirt' }],
  ['collect a few sand', 'collect', { item: 'sand', count: 3 }],
  ['get sixty four stone', 'collect', { item: 'stone', count: 64 }],
  ['get two stacks of gravel', 'collect', { item: 'gravel', count: 128 }],
  ['mine a couple of diamonds', 'collect', { item: 'diamond_ore', count: 2 }],
  ['go mine some coal', 'collect', { item: 'coal_ore' }],
  ['collect 5 sand blocks', 'collect', { item: 'sand', count: 5 }],
  // find
  ['find iron', 'find', { target: 'iron' }],
  ['find a village', 'find', { target: 'village' }],
  ['look for water', 'find', { target: 'water' }],
  ['find me some diamonds', 'find', { target: 'diamonds' }],
  ['where is the nearest village?', 'find', { target: 'village' }],
  ['find diamonds and bring them back', 'find', { target: 'diamonds', bring: true }],
  ['locate a cherry grove within 500 blocks', 'find', { target: 'cherry_grove', radius: 500 }],
  // bring / give / drop
  ['bring me bread', 'bring', { item: 'bread' }],
  ['bring me bread 5', 'bring', { item: 'bread', count: 5 }],
  ['bring me 5 bread', 'bring', { item: 'bread', count: 5 }],
  ['bring me some iron', 'bring', { item: 'iron_ingot' }],
  ['fetch the torches to me', 'bring', { item: 'torch' }],
  ['get me some bread', 'bring', { item: 'bread' }],
  ['give me your bread', 'give', { item: 'bread' }],
  ['give me 3 of your apples', 'give', { item: 'apple', count: 3 }],
  ['gimme your logs', 'give', { item: 'log' }],
  ['give me 10 cobblestone', 'give', { item: 'cobblestone', count: 10 }],
  ['drop your dirt', 'drop', { item: 'dirt' }],
  ['drop 5 cobble', 'drop', { item: 'cobblestone', count: 5 }],
  ['drop everything', 'drop', { item: 'all' }],
  ['throw away the rotten flesh', 'drop', { item: 'rotten_flesh' }],
  // eat / sleep
  ['eat', 'eat'],
  ['eat something', 'eat'],
  ['go to sleep', 'sleep'],
  ['go to bed', 'sleep'],
  // info
  ['status', 'status'],
  ['what are you doing?', 'status'],
  ["what's up", 'status'],
  ['where are you?', 'where'],
  ['coords', 'where'],
  ['inventory', 'inventory'],
  ['what do you have?', 'inventory'],
  ['help', 'help'],
  ['what can you do?', 'help'],
  // build
  ['build a house', 'build', { template: 'small_house' }],
  ['build a house here', 'build', { template: 'small_house', at: 'speaker' }],
  ['build me a log cabin', 'build', { template: 'cabin' }],
  ['build a watchtower over there', 'build', { template: 'watchtower', at: 'speaker' }],
  ['put up a shelter', 'build', { template: 'shelter' }],
  // must NOT trigger: chat between players, questions, statements, compound requests
  ['did you follow him?', null],
  ['do you have bread?', null],
  ['are you going home?', null],
  ['i think we should go home', null],
  ['lol', null],
  ['nice house', null],
  ["I'm going to get some wood", null],
  ['steve come here', null],
  ['why did you stop?', null],
  ['how do I build a house?', null],
  ['is there a way to get iron', null],
  ['that creeper blew up my farm', null],
  ['follow me and then chop some wood and build a house', null],
  ['build a road to the village', null],
  ['have you eaten?', null],
  ['you should not have done that', null],
  ['should I go home?', null],
  ['the guard is asleep', null],
  ['', null]
]

for (const [phrase, intent, args] of CASES) {
  test(`parse: ${JSON.stringify(phrase)} -> ${intent ?? 'nothing'}`, () => {
    const r = parseIntent(phrase, ctx)
    if (intent === null) {
      assert.ok(!r || r.confidence < DEFAULT_THRESHOLD, `expected no intent, got ${JSON.stringify(r)}`)
      return
    }
    assert.ok(r, 'no intent')
    assert.equal(r.intent, intent, JSON.stringify(r))
    assert.ok(r.confidence >= DEFAULT_THRESHOLD, `confidence ${r.confidence}`)
    for (const [k, v] of Object.entries(args ?? {})) assert.deepEqual(r.args[k], v, `${k} in ${JSON.stringify(r.args)}`)
  })
}

test('the table is big enough', () => {
  assert.ok(CASES.length >= 80, `${CASES.length} cases`)
})

test('addressing: name at the start or end, whisper, alone; not in the middle', () => {
  const names = ['Pax', 'pax']
  assert.deepEqual(addressed('pax, guard me', { names }), { body: 'guard me', explicit: true })
  assert.deepEqual(addressed('Pax follow me', { names }), { body: 'follow me', explicit: true })
  assert.deepEqual(addressed('@Pax: stop', { names }), { body: 'stop', explicit: true })
  assert.deepEqual(addressed('hey pax come here', { names }), { body: 'come here', explicit: true })
  assert.deepEqual(addressed('follow me pax', { names }), { body: 'follow me', explicit: true })
  assert.deepEqual(addressed('what are you doing, Pax?', { names }), { body: 'what are you doing', explicit: true })
  assert.equal(addressed('i think pax is lost', { names }), null)
  assert.equal(addressed('follow me', { names }), null)
  assert.equal(addressed('paxton follow me', { names }), null)
  assert.deepEqual(addressed('follow me', { names, whisper: true }), { body: 'follow me', explicit: true })
  assert.deepEqual(addressed('follow me', { names, alone: true }), { body: 'follow me', explicit: false })
  assert.deepEqual(addressed('follow me', { names, inConversation: true }), { body: 'follow me', explicit: false })
})

test('numbers: digits, words, stacks, vague amounts', () => {
  assert.equal(leadingCount('64 cobble').count, 64)
  assert.equal(leadingCount('twenty five logs').count, 25)
  assert.equal(leadingCount('sixty-four stone').count, 64)
  assert.equal(leadingCount('a stack of dirt').count, 64)
  assert.equal(leadingCount('half a stack of dirt').count, 32)
  assert.equal(leadingCount('3 stacks of dirt').count, 192)
  assert.equal(leadingCount('a few apples').count, 3)
  assert.equal(leadingCount('a dozen eggs').count, 12)
  assert.equal(leadingCount('some bread').count, undefined)
  assert.equal(leadingCount('a torch').count, 1)
})

test('items: aliases, plurals, block vs item context', () => {
  assert.equal(normalizeItem('cobble', 'block'), 'cobblestone')
  assert.equal(normalizeItem('logs', 'block'), 'log')
  assert.equal(normalizeItem('wood', 'item'), 'log')
  assert.equal(normalizeItem('wooden planks', 'item'), 'planks')
  assert.equal(normalizeItem('spruce logs', 'block'), 'spruce_log')
  assert.equal(normalizeItem('iron', 'block'), 'iron_ore')
  assert.equal(normalizeItem('iron', 'item'), 'iron_ingot')
  assert.equal(normalizeItem('diamonds', 'item'), 'diamond')
  assert.equal(normalizeItem('potatoes', 'item'), 'potato')
  assert.equal(normalizeItem('torches', 'item'), 'torch')
  assert.equal(normalizeItem('glass', 'item'), 'glass')
  assert.equal(normalizeItem('sweet berries', 'item'), 'sweet_berries')
  assert.equal(normalizeItem('stone bricks', 'block'), 'stone_bricks')
})
