// Labelled example phrasings for the embeddings layer: the nearest examples decide the intent.
// They include the phrasings of the parser's test table plus looser ones the patterns don't
// cover. `none` holds chat that must not trigger anything (questions, statements, chat between
// players), so a line closest to those is left alone. Profiles add their own under
// intents.examples (same shape). The held-out benchmark set (test/fixtures/intents-heldout.ts)
// must not repeat any of these; test/intents-layers.test.ts checks that.
import type { IntentName } from './parse.ts'

export type ExampleLabel = IntentName | 'none'
export type Examples = Partial<Record<ExampleLabel, string[]>>

export const EXAMPLES: Examples = {
  follow: [
    'follow me', 'can you follow me', 'please follow me around', 'come with me', 'tag along', 'stick with us', 'follow steve',
    'follow me at 5 blocks', 'stay with me', 'keep up with me', 'walk with me', 'stay close to me', 'come along', 'stick close to me',
    'keep following me', 'accompany me', 'on me', 'walk behind me', 'stay by my side', 'trail behind me', 'go where i go',
    'join me on my walk', 'you are coming with me'
  ],
  unfollow: [
    'stop following me', 'do not follow me', 'leave me alone', 'go away', 'stop tailing me', 'quit following me around',
    'stop chasing me', 'you can stop following', 'no need to follow me anymore', 'quit tagging along', 'stop coming after me',
    'give me some space', 'stay away from me'
  ],
  come: [
    'come here', 'come here please', 'get over here', 'come back', 'over here', 'could you come to me', 'come to me', 'come over here',
    'return to me', 'come closer', 'get back here', 'meet me here', 'come find me', 'i need you here', 'walk over to me', 'run to me',
    'hurry over here', 'get yourself over here', 'come to where i am', 'make your way to me'
  ],
  go_home: [
    'go home', 'head back home', 'return to base', 'go back home', 'back to base', 'head home', 'return home', 'go back to your home',
    'get yourself home', 'run home', 'time to go home', 'retreat to the base', 'walk back to the house', 'off you go home',
    'make your way home', 'go back to our base'
  ],
  goto: [
    'go to the farm', 'go to farm:1', 'go to 100 64 -20', 'walk to 100 -20', 'go there', 'go to steve', 'head to the mine',
    'travel to the village', 'walk over there', 'go to the lake', 'run to the tower', 'move to 50 70 50', 'go over to the bridge',
    'make your way to the shop', 'get to the wheat field', 'go stand over there', 'head over to the castle'
  ],
  guard: [
    'guard me', 'protect me', 'be my bodyguard', 'watch my back', 'guard here', 'defend this area', 'guard the farm', 'keep me safe',
    'cover me', 'i need protection', 'have my back', 'defend me', 'look after me', 'watch over me', 'keep an eye on me', 'escort me',
    'protect this place', 'patrol the base', 'keep the monsters off me', 'fight off anything that attacks me', 'kill the mobs around me',
    'keep the zombies away from me', 'stand guard here'
  ],
  unguard: [
    'stop guarding', 'stand down', 'stop protecting me', 'at ease', 'off duty', 'dismissed', 'you can stop guarding', 'quit guarding',
    'no more guarding', 'you do not need to protect me anymore', 'stop defending this place', 'relax you are off guard duty'
  ],
  stop: [
    'stop', 'cancel that', 'never mind', 'stay here', 'wait', 'halt', 'freeze', 'abort', 'forget it', 'cut it out', 'hold on', 'stop it',
    'stop everything', 'stop what you are doing', 'stay put', 'wait here', 'do not move', 'stand still', 'hold your position', 'enough',
    'drop what you are doing', 'quit it', 'cancel everything', 'pause', 'that is enough'
  ],
  behavior_on: [
    'start farming', 'keep chopping', 'go exploring', 'turn on keep_fed', 'start chopping', 'begin farming', 'resume farming',
    'carry on chopping', 'go wandering', 'start collecting', 'enable farm_loop', 'get back to farming', 'start lighting the area',
    'keep exploring', 'look after the farm on your own', 'keep cutting trees on your own', 'start your woodcutting routine'
  ],
  behavior_off: [
    'stop chopping', 'stop farming for now', 'disarm farm_loop', 'stop exploring', 'quit farming', 'no more chopping', 'pause farming',
    'turn off keep_fed', 'disable wander', 'stop wandering around', 'enough exploring', 'stop collecting', 'give the farming a rest'
  ],
  farm: [
    'farm the wheat', 'harvest the crops', 'farm at farm:1', 'make a farm', 'start a farm here', 'harvest the wheat', 'tend the crops',
    'go farm', 'work the field', 'reap the wheat', 'harvest the carrots', 'plant a farm', 'set up a farm', 'build a wheat farm here',
    'pick the crops', 'gather the harvest', 'do some farming', 'tend the farm'
  ],
  chop: [
    'chop some wood', 'get wood', 'chop wood', 'chop a tree', 'chop down three trees', 'get 20 logs', 'gather a stack of wood',
    'get me some planks', 'get 16 oak logs', 'cut down a tree', 'fell a tree', 'collect some logs', 'go chop trees', 'get some timber',
    'cut some wood', 'chop down some trees', 'go get some wood', 'gather logs', 'lumberjack', 'get some birch logs', 'cut down 5 trees',
    'go get lumber'
  ],
  collect: [
    'get 64 cobblestone', 'get a stack of cobble', 'mine 10 iron', 'mine ten iron', 'dig some dirt', 'collect a few sand',
    'get sixty four stone', 'get two stacks of gravel', 'mine a couple of diamonds', 'go mine some coal', 'collect 5 sand blocks',
    'mine some stone', 'dig up some clay', 'gather cobblestone', 'grab some gravel', 'dig 20 dirt', 'mine iron ore', 'get some coal',
    'collect stone', 'quarry some stone', 'mine copper', 'dig sand', 'go dig for iron', 'gather some sand', 'mine gold'
  ],
  find: [
    'find iron', 'find a village', 'look for water', 'find me some diamonds', 'where is the nearest village', 'find diamonds and bring them back',
    'locate a cherry grove within 500 blocks', 'search for a cave', 'look for a desert temple', 'track down a mineshaft', 'find the nearest lava',
    'scout for a village', 'locate some sheep', 'search for diamonds', 'find a stronghold', 'look for a cow', 'seek out a river', 'find a cave'
  ],
  bring: [
    'bring me bread', 'bring me bread 5', 'bring me 5 bread', 'bring me some iron', 'fetch the torches to me', 'get me some bread',
    'bring me food', 'fetch me some apples', 'bring me a pickaxe', 'deliver some coal to me', 'bring the torches here', 'get me an axe',
    'bring me something to eat', 'fetch me 10 arrows', 'bring me a sword', 'i need some bread', 'i need torches'
  ],
  give: [
    'give me your bread', 'give me 3 of your apples', 'gimme your logs', 'give me 10 cobblestone', 'hand me your sword', 'pass me the torches',
    'give me some of your food', 'toss me your apples', 'hand over your coal', 'give me your iron', 'pass me a pickaxe', 'throw me some bread'
  ],
  drop: [
    'drop your dirt', 'drop 5 cobble', 'drop everything', 'throw away the rotten flesh', 'drop all your stuff', 'toss the gravel',
    'get rid of the dirt', 'discard the seeds', 'empty your inventory', 'dump your cobblestone', 'throw out the junk', 'drop it all'
  ],
  eat: [
    'eat', 'eat something', 'eat some food', 'have a snack', 'grab a bite', 'feed yourself', 'have something to eat', 'go eat',
    'you should eat', 'have lunch', 'fill your belly', 'eat up', 'top up your hunger'
  ],
  sleep: [
    'go to sleep', 'go to bed', 'sleep', 'take a nap', 'bedtime', 'time for bed', 'hit the hay', 'get some sleep', 'use the bed',
    'skip the night', 'sleep through the night', 'lie down in the bed'
  ],
  status: [
    'status', 'what are you doing', 'what is up', 'what are you up to', 'how are you', 'how is it going', 'are you busy', 'status report',
    'what are you working on', 'report', 'sitrep', 'are you ok', 'how are things going', 'give me an update'
  ],
  where: [
    'where are you', 'coords', 'where are you at', 'your position', 'send coords', 'what are your coordinates', 'location',
    'where did you go', 'tell me your location', 'what are your coords', 'where are you right now'
  ],
  inventory: [
    'inventory', 'what do you have', 'what are you carrying', 'show me your inventory', 'what is in your inventory', 'check your inventory',
    'what have you got', 'list your items', 'what is in your pockets', 'show your stuff', 'what do you have on you'
  ],
  set_home: [
    'set home', 'set home here', 'this is your home', 'make this your home', 'your home is here', 'set your home to here',
    'live here from now on', 'this is home now', 'mark this as home'
  ],
  remember_place: [
    'remember this place as the mine', 'save this spot as wheat field', 'remember this spot as the lake', 'mark this location as the quarry',
    'save this place as base camp', 'call this spot the shop', 'this is the forge remember it', 'note this position as the portal'
  ],
  build: [
    'build a house', 'build a house here', 'build me a log cabin', 'build a watchtower over there', 'put up a shelter', 'build a tower',
    'construct a cottage', 'build a hut here', 'make a small house', 'build a wall', 'set up a shelter here', 'build us a fort',
    'construct a platform'
  ],
  help: [
    'help', 'what can you do', 'commands', 'what do you understand', 'what can i say', 'list commands', 'how do i use you',
    'what are your commands', 'show me what you can do'
  ],
  none: [
    'did you follow him', 'do you have bread', 'are you going home', 'i think we should go home', 'lol', 'nice house',
    'i am going to get some wood', 'steve come here', 'why did you stop', 'how do i build a house', 'is there a way to get iron',
    'that creeper blew up my farm', 'follow me and then chop some wood and build a house', 'build a road to the village', 'have you eaten',
    'you should not have done that', 'should i go home', 'the guard is asleep', 'hello', 'good morning', 'thanks', 'ok', 'yes', 'no',
    'haha', 'brb', 'gg', 'nice one', 'what time is it', 'i love this server', 'my internet is lagging', 'who built that tower',
    'that was close', 'i found diamonds earlier', 'the zombies are annoying tonight', 'did you see that', 'i am hungry', 'it is raining',
    'where did steve go', 'can someone help me', 'i will be right back', 'sorry wrong chat', 'you are a good bot', 'that is cool',
    'i went home already', 'i chopped some wood yesterday', 'we need a bigger farm someday', 'he is following me', 'the farm looks great',
    'was that you', 'what do you think about creepers', 'tell me a joke', 'how old are you', 'never do that again'
  ]
}

/** Example lists merged: profile examples are added to the built-in ones. */
export function mergeExamples (base: Examples, extra?: Examples): Examples {
  if (!extra) return base
  const out: Examples = { ...base }
  for (const [label, list] of Object.entries(extra) as [ExampleLabel, string[]][]) out[label] = [...(out[label] ?? []), ...list]
  return out
}
