// Minimal readers/writers for the NeoForge 21.1 (MC 1.21.1) handshake payloads.
// Wire formats come from neoforged/NeoForge@1.21.1 src/main/java/net/neoforged/neoforge/network/payload/.
import nbt from 'prismarine-nbt'

// net.minecraft.network.ConnectionProtocol ordinals (1.21.1)
export const PROTOCOL = { HANDSHAKING: 0, PLAY: 1, STATUS: 2, LOGIN: 3, CONFIGURATION: 4 }
// net.minecraft.network.protocol.PacketFlow ordinals
export const FLOW = { SERVERBOUND: 0, CLIENTBOUND: 1 }

export class Writer {
  constructor () { this.parts = [] }
  varint (v) {
    const bytes = []
    v >>>= 0
    do {
      let b = v & 0x7f
      v >>>= 7
      if (v) b |= 0x80
      bytes.push(b)
    } while (v)
    this.parts.push(Buffer.from(bytes))
    return this
  }

  bool (v) { this.parts.push(Buffer.from([v ? 1 : 0])); return this }
  string (s) {
    const b = Buffer.from(s, 'utf8')
    this.varint(b.length)
    this.parts.push(b)
    return this
  }

  buffer () { return Buffer.concat(this.parts) }
}

export class Reader {
  constructor (buf) { this.buf = buf; this.o = 0 }
  get done () { return this.o >= this.buf.length }
  varint () {
    let v = 0; let s = 0; let b
    do {
      b = this.buf[this.o++]
      v |= (b & 0x7f) << s
      s += 7
    } while (b & 0x80)
    return v >>> 0
  }

  bool () { return this.buf[this.o++] !== 0 }
  string () {
    const len = this.varint()
    const s = this.buf.toString('utf8', this.o, this.o + len)
    this.o += len
    return s
  }

  nbt () {
    const r = nbt.protos.big.read(this.buf, this.o, 'anonymousNbt')
    this.o += r.size
    return nbt.simplify(r.value)
  }
}

/**
 * ModdedNetworkQueryPayload: Map<ConnectionProtocol, Set<ModdedNetworkQueryComponent>>
 * component = (ResourceLocation id, String version, Optional<PacketFlow> flow, boolean optional)
 * @param {Record<number, Array<{id: string, version: string, flow: string|null, optional: boolean}>>} queries
 */
export function encodeQuery (queries) {
  const w = new Writer()
  const entries = Object.entries(queries)
  w.varint(entries.length)
  for (const [protocol, comps] of entries) {
    w.varint(Number(protocol))
    w.varint(comps.length)
    for (const c of comps) {
      w.string(c.id).string(c.version ?? '')
      if (c.flow) w.bool(true).varint(FLOW[c.flow]); else w.bool(false)
      w.bool(c.optional)
    }
  }
  return w.buffer()
}

/** ModdedNetworkSetupFailedPayload: Map<ResourceLocation, Component(NBT)> */
export function decodeSetupFailed (buf) {
  const r = new Reader(buf)
  const n = r.varint()
  const out = {}
  for (let i = 0; i < n; i++) {
    const id = r.string()
    out[id] = r.nbt()
  }
  return out
}

/** NetworkPayloadSetup: Map<ConnectionProtocol, Map<ResourceLocation, NetworkChannel(id, String chosenVersion)>> */
export function decodeNetworkSetup (buf) {
  const r = new Reader(buf)
  const out = {}
  const n = r.varint()
  for (let i = 0; i < n; i++) {
    const protocol = r.varint()
    const m = r.varint()
    out[protocol] = []
    for (let j = 0; j < m; j++) {
      r.string() // map key, same as id
      const id = r.string()
      const version = r.string()
      out[protocol].push({ id, version })
    }
  }
  return out
}

/** Flattens a translatable NBT component into { key, args } where args are strings or nested results. */
export function flattenComponent (c) {
  if (c == null) return null
  if (typeof c === 'string') return c
  if (typeof c === 'object' && '' in c && Object.keys(c).length === 1) return flattenComponent(c[''])
  if (c.translate) return { key: c.translate, args: (c.with || []).map(flattenComponent) }
  if (typeof c.text === 'string') return c.text
  return JSON.stringify(c)
}

/** Digs through "failure.mod" wrappers and returns the innermost negotiation failure. */
export function failureReason (component) {
  let f = flattenComponent(component)
  while (f && typeof f === 'object' && f.key === 'neoforge.network.negotiation.failure.mod') f = f.args[1]
  return f
}
