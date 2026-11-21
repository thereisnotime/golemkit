// Parses vanilla death messages ("Pax was slain by Zombie Villager") into victim, cause and
// killer. Only the en_us vanilla wording is known; anything else returns null so ordinary
// system messages are never taken for deaths.

export interface DeathInfo {
  victim: string
  /** Short category: slain, shot, explosion, fall, fire, lava, drowning, ... */
  cause: string
  killer?: string
  weapon?: string
  /** The message as the server sent it. */
  message: string
}

// [pattern on the text after the victim's name, cause]. A capture group named k is the killer,
// w the weapon. Order matters: the more specific wording first.
const K = '(?<k>.+?)'
const W = '(?:whilst|while)'
const USING = '(?: using (?<w>.+))?'
const PATTERNS: [RegExp, string][] = [
  [new RegExp(`^was slain by ${K}${USING}$`), 'slain'],
  [new RegExp(`^was shot by a skull from ${K}${USING}$`), 'wither_skull'],
  [new RegExp(`^was shot by ${K}${USING}$`), 'shot'],
  [new RegExp(`^was fireballed by ${K}${USING}$`), 'fireball'],
  [new RegExp(`^was pummeled by ${K}${USING}$`), 'pummeled'],
  [new RegExp(`^was impaled by ${K}${USING}$`), 'trident'],
  [new RegExp(`^was skewered by a falling stalactite(?: ${W} fighting ${K})?$`), 'stalactite'],
  [new RegExp(`^was impaled on a stalagmite(?: ${W} fighting ${K})?$`), 'stalagmite'],
  [/^was killed by \[Intentional Game Design\]$/, 'bed_explosion'],
  [/^was killed by (?:even more )?magic$/, 'magic'],
  [new RegExp(`^was killed while trying to hurt ${K}$`), 'thorns'],
  [new RegExp(`^was killed by ${K} using magic$`), 'magic'],
  [new RegExp(`^was killed by ${K}${USING}$`), 'magic'],
  [new RegExp(`^was blown up by ${K}${USING}$`), 'explosion'],
  [/^blew up$/, 'explosion'],
  [new RegExp(`^was stung to death(?: by ${K}${USING})?$`), 'sting'],
  [new RegExp(`^drowned(?: ${W} trying to escape ${K})?$`), 'drowning'],
  [new RegExp(`^died from dehydration(?: ${W} trying to escape ${K})?$`), 'dehydration'],
  [new RegExp(`^(?:hit the ground too hard|fell from a high place)(?: ${W} trying to escape ${K})?$`), 'fall'],
  [/^fell (?:off a ladder|off some (?:twisting |weeping )?vines|off scaffolding|out of the water|while climbing)$/, 'fall'],
  [new RegExp(`^was doomed to fall(?: by ${K}${USING})?$`), 'fall'],
  [new RegExp(`^fell too far and was finished by ${K}${USING}$`), 'fall'],
  [new RegExp(`^was squashed by a falling (?:anvil|block)(?: ${W} fighting ${K})?$`), 'falling_block'],
  [new RegExp(`^(?:went up in flames|burned to death)$`), 'fire'],
  [new RegExp(`^(?:walked into fire|was burned to a crisp|was burnt to a crisp) ${W} fighting ${K}${USING}$`), 'fire'],
  [new RegExp(`^tried to swim in lava(?: to escape ${K})?$`), 'lava'],
  [new RegExp(`^discovered the floor was lava$`), 'hot_floor'],
  [new RegExp(`^walked into the danger zone due to ${K}$`), 'hot_floor'],
  [new RegExp(`^was struck by lightning(?: ${W} fighting ${K})?$`), 'lightning'],
  [new RegExp(`^starved to death(?: ${W} fighting ${K})?$`), 'starvation'],
  [new RegExp(`^suffocated in a wall(?: ${W} fighting ${K})?$`), 'suffocation'],
  [new RegExp(`^was squished too much$`), 'cramming'],
  [new RegExp(`^was squashed by ${K}$`), 'cramming'],
  [new RegExp(`^(?:fell out of the world|left the confines of this world)$`), 'void'],
  [new RegExp(`^didn't want to live in the same world as ${K}$`), 'void'],
  [new RegExp(`^withered away(?: ${W} fighting ${K})?$`), 'wither'],
  [new RegExp(`^was pricked to death$`), 'cactus'],
  [new RegExp(`^walked into a cactus ${W} trying to escape ${K}$`), 'cactus'],
  [new RegExp(`^was poked to death by a sweet berry bush(?: ${W} trying to escape ${K})?$`), 'berry_bush'],
  [new RegExp(`^froze to death$`), 'freeze'],
  [new RegExp(`^was frozen to death by ${K}$`), 'freeze'],
  [new RegExp(`^experienced kinetic energy(?: ${W} trying to escape ${K})?$`), 'kinetic'],
  [new RegExp(`^was roasted in dragon's breath(?: by ${K})?$`), 'dragon_breath'],
  [new RegExp(`^was obliterated by a sonically-charged shriek(?: ${W} trying to escape ${K}${USING})?$`), 'sonic_boom'],
  [new RegExp(`^was killed by ${K}$`), 'killed'],
  [new RegExp(`^died(?: because of ${K})?$`), 'generic']
]

const strip = (s: string) => s.replace(/^\[|\]$/g, '').trim()

/**
 * Parses a death message. Pass `victim` to only accept messages about that player (the name
 * can contain spaces then, as with some modded display names).
 */
export function parseDeathMessage (text: string, victim?: string): DeathInfo | null {
  const message = text.replace(/§./g, '').trim()
  let name: string
  let rest: string
  if (victim) {
    if (!message.startsWith(victim + ' ')) return null
    name = victim
    rest = message.slice(victim.length + 1)
  } else {
    const m = /^(\S+) (.+)$/.exec(message)
    if (!m) return null
    name = m[1]
    rest = m[2]
  }
  for (const [re, cause] of PATTERNS) {
    const m = re.exec(rest)
    if (!m) continue
    const k = m.groups?.k
    const w = m.groups?.w
    return { victim: name, cause, ...(k ? { killer: strip(k) } : {}), ...(w ? { weapon: strip(w) } : {}), message }
  }
  return null
}

const ADVANCEMENT = /^(\S+) has (?:made the advancement|completed the challenge|reached the goal) \[(.+)\]$/

/** "Pax has made the advancement [Stone Age]" -> { player, advancement }. */
export function parseAdvancement (text: string): { player: string, advancement: string } | null {
  const m = ADVANCEMENT.exec(text.replace(/§./g, '').trim())
  return m ? { player: m[1], advancement: m[2] } : null
}
