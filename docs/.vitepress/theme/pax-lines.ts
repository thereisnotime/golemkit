// What Pax says on the docs site. The quips are the idle_antics lines from
// src/adapters/minecraft-java/behaviors/fun.ts and the grumbles come from GRUMBLES in
// src/skills/containerPlan.ts; the fun facts are numbers from the docs pages.
export const QUIPS = [
  'did anyone else hear that?', 'i think that cow is judging me', 'this block looks suspicious',
  'brb, contemplating the void', 'the sky is very square today',
  'i could build a castle. i won\'t. but i could.', 'do creepers have feelings?',
  'counting blocks... lost count', 'i\'m not idle, i\'m loading',
  'who took my bread?!', 'someone cleaned out my chest... rude', 'my chest wandered off a few blocks',
  'who moved my chest?'
]

export const FACTS = [
  'the pattern layer reads a chat line in about 0 ms; the local MiniLM model takes 2 to 4 ms.',
  'the MiniLM intent model is 23 MB and loads from disk in about 0.2 s.',
  'a 1.5B local LLM picks an intent in about 0.8 s (median) on the dev CPU.',
  'in the mob-wave benchmark the bodyguard took about a third fewer hits than plain follow.',
  'most of the bot\'s benchmark deaths were creepers fought point blank without armour.',
  'every capability is one action with a zod schema: a chat command, an LLM tool and a typed function at once.'
]

/** A bag that hands out every line once before repeating, and never the same line twice in a row. */
export function shuffleBag<T> (items: readonly T[]): () => T {
  let bag: T[] = []
  let last: T | undefined
  return () => {
    if (!bag.length) {
      bag = [...items]
      for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [bag[i], bag[j]] = [bag[j]!, bag[i]!] }
      if (bag.length > 1 && bag[bag.length - 1] === last) bag.unshift(bag.pop()!)
    }
    last = bag.pop()!
    return last
  }
}

/** A stable pick per page path, so the server render and the browser agree. */
export function pickFor (path: string, n: number): number {
  let h = 0
  for (const c of path) h = (h * 31 + c.charCodeAt(0)) | 0
  return Math.abs(h) % n
}
