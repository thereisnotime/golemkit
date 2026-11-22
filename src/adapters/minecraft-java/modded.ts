// Makes block states the vanilla data doesn't know (modded blocks) behave as solid cubes.
// Without this prismarine-block treats them as air, so the bot falls through Create
// casings and pathfinder walks into machines. NeoForge appends modded states after the
// vanilla ones, so vanilla ids stay correct and anything above the vanilla max is modded.
import type { Block } from 'prismarine-block'

export const MODDED_BLOCK = 'modded_block'

export function solidifyUnknownBlocks (registry: any): void {
  const byState = registry.blocksByStateId
  if (byState.__moddedProxy) return
  const stone = registry.blocksByName.stone
  const maxVanilla = Math.max(...Object.keys(byState).map(Number))

  const modded = {
    ...stone,
    name: MODDED_BLOCK,
    displayName: 'Modded block',
    hardness: -1, // never try to dig it
    diggable: false,
    drops: [],
    harvestTools: undefined,
    minStateId: maxVanilla + 1,
    maxStateId: Number.MAX_SAFE_INTEGER,
    defaultState: maxVanilla + 1,
    states: [],
    stateShapes: undefined,
    shapes: [[0, 0, 0, 1, 1, 1]],
    boundingBox: 'block',
    transparent: false
  }

  registry.blocksByStateId = new Proxy(byState, {
    get (target, prop) {
      if (prop === '__moddedProxy') return true
      const v = target[prop]
      if (v !== undefined || typeof prop !== 'string') return v
      const id = Number(prop)
      return Number.isInteger(id) && id > maxVanilla ? modded : undefined
    }
  })
}

export function isModdedBlock (block: Block | null | undefined): boolean {
  return block?.name === MODDED_BLOCK
}
