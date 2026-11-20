// Modded servers send packets that vanilla protocol definitions can't fully parse, mostly
// item stacks carrying modded data components (recipes, inventories, equipment). Item
// components have no length prefix, so a stack with an unknown component can't be skipped
// inside the packet. protodef's FullPacketParser turns such a failure into a stream error,
// which destroys the deserializer and silently kills the connection.
//
// This patch drops the unparseable packet instead and keeps the stream alive.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { FullPacketParser } = require('protodef')

export const skipped = new Map() // packet name or id -> count

let installed = false
export function installTolerantParser (onSkip = () => {}) {
  if (installed) return
  installed = true
  FullPacketParser.prototype._transform = function (chunk, enc, cb) {
    let packet
    try {
      packet = this.parsePacketBuffer(chunk)
    } catch (e) {
      const name = packetName(this, chunk)
      skipped.set(name, (skipped.get(name) || 0) + 1)
      onSkip(name, e)
      return cb()
    }
    this.push(packet)
    cb()
  }
}

function packetName (parser, chunk) {
  try {
    // First field of every packet is its varint id.
    const { value: id } = parser.proto.read(chunk, 0, 'varint')
    return `0x${id.toString(16).padStart(2, '0')}`
  } catch {
    return 'unknown'
  }
}
