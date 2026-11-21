// Held-out paraphrases for scripts/intents-bench.ts: none of these lines is among the embeddings
// layer's examples (src/brains/intents/examples.ts) or the parser's test table, so they measure
// how each layer copes with wording it hasn't seen. null = must not trigger.
import type { LabelledCase } from './intents-seen.ts'

export const HELDOUT_CASES: LabelledCase[] = [
  // follow
  ['stay right behind me', 'follow', { player: 'Tester' }],
  ['come along with me for a walk', 'follow', { player: 'Tester' }],
  ['shadow me', 'follow', { player: 'Tester' }],
  ['keep close', 'follow'],
  ['you are with me, lets move', 'follow'],
  // unfollow
  ['quit following me', 'unfollow'],
  ['stop trailing after me', 'unfollow'],
  ['you can stop tagging along now', 'unfollow'],
  // come
  ['get over to me', 'come', { player: 'Tester' }],
  ['come to my side', 'come', { player: 'Tester' }],
  ['hurry back to me', 'come'],
  ['come here quick', 'come'],
  // go home
  ['could you head back to base', 'go_home'],
  ['go on back home', 'go_home'],
  ['return to your house', 'go_home'],
  ['get back to the base', 'go_home'],
  // goto
  ['head over to the village', 'goto', { place: 'village' }],
  ['walk to the mine', 'goto', { place: 'mine' }],
  ['travel to 200 70 -300', 'goto', { x: 200, y: 70, z: -300 }],
  ['make your way over to the lake', 'goto', { place: 'lake' }],
  // guard
  ['keep me covered', 'guard', { target: 'player' }],
  ['protect me from the mobs', 'guard', { target: 'player' }],
  ['keep the creepers away from me', 'guard', { target: 'player' }],
  ['look out for me', 'guard', { target: 'player' }],
  ['guard this spot', 'guard', { target: 'here' }],
  ['defend the house', 'guard'],
  // unguard
  ['you can relax now, stop protecting', 'unguard'],
  ['stop being my bodyguard', 'unguard'],
  ['no need to guard me anymore', 'unguard'],
  // stop
  ['hold it', 'stop'],
  ['stop right there', 'stop'],
  ['stop what you are up to', 'stop'],
  ['stay where you are', 'stop', { stay: true }],
  ['do not go anywhere', 'stop', { stay: true }],
  // behaviours
  ['start chopping trees on your own', 'behavior_on', { activity: 'chopping' }],
  ['go back to farming', 'behavior_on', { activity: 'farming' }],
  ['quit exploring', 'behavior_off', { activity: 'exploring' }],
  ['stop the farming', 'behavior_off', { activity: 'farming' }],
  // farm
  ['harvest the potatoes', 'farm', { crop: 'potatoes' }],
  ['go harvest the field', 'farm'],
  ['set up a new farm over here', 'farm', { create: true, at: 'speaker' }],
  ['bring in the wheat harvest', 'farm'],
  // wood
  ['chop me some logs', 'chop', { unit: 'log' }],
  ['cut down two trees', 'chop', { count: 2, unit: 'tree' }],
  ['go collect 32 spruce logs', 'chop', { count: 32, unit: 'log', wood: 'spruce' }],
  ['grab some wood', 'chop', { unit: 'log' }],
  ['fell some trees', 'chop', { unit: 'tree' }],
  // collect
  ['grab me some cobble', 'collect', { item: 'cobblestone' }],
  ['dig up twenty sand', 'collect', { item: 'sand', count: 20 }],
  ['mine a stack of stone', 'collect', { item: 'stone', count: 64 }],
  ['get us some gravel', 'collect', { item: 'gravel' }],
  ['go mining for iron', 'collect', { item: 'iron_ore' }],
  ['dig out some coal', 'collect', { item: 'coal_ore' }],
  // find
  ['look around for a village', 'find', { target: 'village' }],
  ['hunt for diamonds', 'find', { target: 'diamonds' }],
  ['search for a desert temple', 'find', { target: 'desert_temple' }],
  ['where can we find some sheep', 'find'],
  // bring
  ['bring me some torches', 'bring', { item: 'torch' }],
  ['fetch me a pickaxe', 'bring', { item: 'pickaxe' }],
  ['bring 3 apples over here', 'bring', { item: 'apple', count: 3 }],
  ['i could use some bread', 'bring', { item: 'bread' }],
  // give
  ['hand me your bread', 'give', { item: 'bread' }],
  ['give me some of your coal', 'give', { item: 'coal' }],
  ['pass me your torches', 'give', { item: 'torch' }],
  // drop
  ['drop the gravel', 'drop', { item: 'gravel' }],
  ['toss out your dirt', 'drop', { item: 'dirt' }],
  ['empty your pockets', 'drop', { item: 'all' }],
  // eat / sleep
  ['get some food in you', 'eat'],
  ['have a meal', 'eat'],
  ['grab some food yourself and eat', 'eat'],
  ['go get some rest in the bed', 'sleep'],
  ['off to bed with you', 'sleep'],
  ['catch some sleep', 'sleep'],
  // info
  ['how are you doing', 'status'],
  ['what are you busy with', 'status'],
  ['tell me where you are', 'where'],
  ['what is your location', 'where'],
  ['what is in your bag', 'inventory'],
  ['show me what you are carrying', 'inventory'],
  ['what commands do you know', 'help'],
  // home and places
  ['make this spot your home', 'set_home', { at: 'speaker' }],
  ['remember this spot as the quarry', 'remember_place', { name: 'quarry' }],
  // build
  ['build a small house over here', 'build', { template: 'small_house', at: 'speaker' }],
  ['put up a watchtower', 'build', { template: 'watchtower' }],
  ['build me a cabin', 'build', { template: 'cabin' }],
  // must NOT trigger
  ['i followed the river yesterday', null],
  ['did you eat already?', null],
  ['are you guarding the farm?', null],
  ['where did you put the bread?', null],
  ['i just got home', null],
  ['my house burned down lol', null],
  ['steve, give me your sword', null],
  ['that skeleton almost killed me', null],
  ['why are you following me?', null],
  ['have you seen a village around here?', null],
  ['we should build a castle sometime', null],
  ['i hate creepers', null],
  ['how do you mine obsidian?', null],
  ['good night everyone', null],
  ['what a nice sunset', null],
  ['you did great earlier', null],
  ['do not ever touch my chest', null],
  ['is it day yet?', null],
  ['i need to go afk for a bit', null],
  ['can anyone trade me some iron', null],
  ['the server restarts at noon', null],
  ['go to sleep and then chop wood and then build a tower', null]
]
