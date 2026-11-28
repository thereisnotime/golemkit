// An item's enchantments as a plain list. mineflayer's item.enchants is normally an array, but
// modded servers (NeoForge components) can hand back something else: an object, a map or junk.
// Pax crashed on `(it.enchants ?? []).reduce is not a function` in the armour check; every reader
// goes through here so a strange item is "no enchantments", never a crash.

export interface Enchant { name: string, lvl: number }

export function enchantsOf (item: unknown): Enchant[] {
  let raw: unknown
  try { raw = (item as { enchants?: unknown } | null | undefined)?.enchants } catch { return [] }
  return enchantList(raw)
}

export function enchantList (raw: unknown): Enchant[] {
  if (raw == null) return []
  let list: unknown[]
  if (Array.isArray(raw)) list = raw
  else if (raw instanceof Map) list = [...raw].map(([name, lvl]) => ({ name, lvl }))
  else if (typeof raw === 'object') list = Object.entries(raw as Record<string, unknown>).map(([name, v]) => (v && typeof v === 'object' ? { name, ...(v as object) } : { name, lvl: v }))
  else return []
  const out: Enchant[] = []
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const name = String((e as { name?: unknown }).name ?? '').replace(/^minecraft:/, '')
    const lvl = Number((e as { lvl?: unknown, level?: unknown }).lvl ?? (e as { level?: unknown }).level ?? 1)
    if (name) out.push({ name, lvl: Number.isFinite(lvl) ? lvl : 1 })
  }
  return out
}
