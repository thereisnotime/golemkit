// NeoForge 21.1 configuration-phase handshake for a node-minecraft-protocol client.
import type { Client } from 'minecraft-protocol'
import { encodeQuery, decodeSetupFailed, decodeNetworkSetup, PROTOCOL, Writer, Reader, type QueryComponent, type NetworkSetup } from './codec.ts'
import type { ChannelStore } from './channelStore.ts'

// Channel ids must match NeoForge's ResourceLocations exactly (see payload/*.java on branch 1.21.1).
const CH = {
  QUERY: 'neoforge:register',
  NETWORK: 'neoforge:network',
  SETUP_FAILED: 'neoforge:modded_network_setup_failed',
  MC_REGISTER: 'minecraft:register',
  DATA_MAPS: 'neoforge:known_registry_data_maps',
  DATA_MAPS_REPLY: 'neoforge:known_registry_data_maps_reply',
  C_VERSION: 'c:version',
  C_REGISTER: 'c:register',
  ENUM_DATA: 'neoforge:extensible_enum_data',
  ENUM_ACK: 'neoforge:extensible_enum_ack',
  FLAGS_DATA: 'neoforge:feature_flags',
  FLAGS_ACK: 'neoforge:feature_flags_ack',
  REG_START: 'neoforge:frozen_registry_sync_start',
  REG: 'neoforge:frozen_registry',
  REG_DONE: 'neoforge:frozen_registry_sync_completed',
  CONFIG_FILE: 'neoforge:config_file'
} as const

// NeoForge's own configuration-phase payloads (NetworkInitialization, registrar version "1").
// The server registers them as optional, so if we don't offer them they get dropped, and the
// CheckExtensibleEnums task then hangs trying to send to a channel we don't have.
const BUILTIN_CONFIGURATION: QueryComponent[] = ([
  { id: CH.CONFIG_FILE, flow: 'CLIENTBOUND' },
  { id: CH.REG_START, flow: 'CLIENTBOUND' },
  { id: CH.REG, flow: 'CLIENTBOUND' },
  { id: CH.REG_DONE, flow: null },
  { id: CH.DATA_MAPS, flow: 'CLIENTBOUND' },
  { id: CH.ENUM_DATA, flow: 'CLIENTBOUND' },
  { id: CH.FLAGS_DATA, flow: 'CLIENTBOUND' },
  { id: CH.DATA_MAPS_REPLY, flow: 'SERVERBOUND' },
  { id: CH.ENUM_ACK, flow: 'SERVERBOUND' },
  { id: CH.FLAGS_ACK, flow: 'SERVERBOUND' }
] as const).map(c => ({ ...c, version: '1', optional: true }))

export interface NeoForgeEvents {
  /** negotiation rejected; failures decoded per channel */
  neoforge_failed: (failures: Record<string, unknown>) => void
  /** negotiation accepted */
  neoforge_ready: (setup: NetworkSetup) => void
  /** configuration payloads we don't answer (debugging) */
  neoforge_unhandled: (channel: string, data: Buffer) => void
}

/** Attaches the handshake to a client. See NeoForgeEvents for what it emits on the client. */
export function attachNeoForge (client: Client, store: ChannelStore, log: (msg: string) => void = () => {}): { readonly accepted: NetworkSetup | null } {
  let accepted: NetworkSetup | null = null

  const send = (channel: string, data: Buffer) => client.write('custom_payload', { channel, data })

  client.on('custom_payload', (packet: { channel: string, data: Buffer }) => {
    if (client.state !== 'configuration') return
    const { channel, data } = packet

    switch (channel) {
      case CH.QUERY: {
        const comps = store.components()
        const config = [...BUILTIN_CONFIGURATION, ...comps.filter(c => !BUILTIN_CONFIGURATION.some(b => b.id === c.id))]
        send(CH.QUERY, encodeQuery({ [PROTOCOL.CONFIGURATION]: config, [PROTOCOL.PLAY]: comps }))
        log(`offered ${comps.length} learned + ${BUILTIN_CONFIGURATION.length} builtin channels`)
        break
      }
      case CH.SETUP_FAILED:
        client.emit('neoforge_failed', decodeSetupFailed(data))
        break
      case CH.NETWORK: {
        const setup = decodeNetworkSetup(data)
        accepted = setup
        const configChannels = (setup[PROTOCOL.CONFIGURATION] ?? []).map(c => c.id)
        log(`accepted (${Object.values(setup).reduce((n, l) => n + l.length, 0)} channels negotiated)`)
        // Tell the server which channels we listen on in the configuration phase.
        const names = [CH.QUERY, CH.NETWORK, CH.SETUP_FAILED, ...configChannels]
        send(CH.MC_REGISTER, Buffer.from(names.join('\0')))
        client.emit('neoforge_ready', setup)
        break
      }
      case CH.MC_REGISTER:
        break
      case CH.DATA_MAPS: {
        // Map<registry, List<KnownDataMap(id, mandatory)>>. Claim we know all of them so
        // mandatory maps don't get us kicked; their play-phase sync is simply ignored.
        const r = new Reader(data)
        const w = new Writer()
        const n = r.varint()
        w.varint(n)
        for (let i = 0; i < n; i++) {
          w.string(r.string())
          const m = r.varint()
          w.varint(m)
          for (let j = 0; j < m; j++) {
            w.string(r.string())
            r.bool() // mandatory
          }
        }
        send(CH.DATA_MAPS_REPLY, w.buffer())
        break
      }
      case CH.ENUM_DATA:
        send(CH.ENUM_ACK, Buffer.alloc(0))
        break
      case CH.FLAGS_DATA:
        send(CH.FLAGS_ACK, Buffer.alloc(0))
        break
      case CH.REG_START:
      case CH.REG:
      case CH.CONFIG_FILE:
        break
      case CH.REG_DONE:
        send(CH.REG_DONE, Buffer.alloc(0))
        break
      case CH.C_VERSION:
        // Common networking: we speak version 1.
        send(CH.C_VERSION, new Writer().varint(1).varint(1).buffer())
        break
      case CH.C_REGISTER:
        // Echo back an empty registration for the same phase.
        try {
          const r = new Reader(data)
          r.varint() // version
          const phase = r.string()
          send(CH.C_REGISTER, new Writer().varint(1).string(phase).varint(0).buffer())
        } catch {}
        break
      default:
        client.emit('neoforge_unhandled', channel, data)
    }
  })

  return { get accepted () { return accepted } }
}
