// Modded servers send packets that vanilla protocol definitions can't fully parse, mostly
// item stacks carrying modded data components (recipes, inventories, equipment). Item
// components have no length prefix, so a stack with an unknown component can't be skipped
// inside the packet. protodef's FullPacketParser turns such a failure into a stream error,
// which destroys the deserializer and silently kills the connection.
//
// This patch drops the unparseable packet instead and keeps the stream alive.
// It is process-wide, so every bot in a fleet shares it.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { FullPacketParser } = require('protodef')

export const skipped = new Map<string, number>() // packet id -> count

type SkipHandler = (packetId: string, err: Error) => void
const handlers = new Set<SkipHandler>()

let installed = false

/** Installs the patch (once) and registers a handler; returns an unsubscribe function. */
export function installTolerantParser (onSkip?: SkipHandler): () => void {
  if (onSkip) handlers.add(onSkip)
  if (!installed) {
    installed = true
    FullPacketParser.prototype._transform = function (chunk: Buffer, _enc: string, cb: (err?: Error) => void) {
      let packet
      try {
        packet = this.parsePacketBuffer(chunk)
      } catch (e) {
        const id = packetId(this, chunk)
        skipped.set(id, (skipped.get(id) ?? 0) + 1)
        for (const h of handlers) h(id, e as Error)
        return cb()
      }
      this.push(packet)
      cb()
    }
  }
  return () => { if (onSkip) handlers.delete(onSkip) }
}

function packetId (parser: any, chunk: Buffer): string {
  try {
    // First field of every packet is its varint id.
    const { value: id } = parser.proto.read(chunk, 0, 'varint')
    return `0x${id.toString(16).padStart(2, '0')}`
  } catch {
    return 'unknown'
  }
}
