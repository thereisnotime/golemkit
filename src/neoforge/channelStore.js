// Keeps the list of NeoForge payload channels the server requires, learned from
// negotiation failures, so later logins pass the handshake on the first try.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { failureReason } from './codec.js'

const PREFIX = 'neoforge.network.negotiation.failure.'

export class ChannelStore {
  constructor (file) {
    this.file = file
    this.channels = {} // id -> { version, flow }
    try {
      this.channels = JSON.parse(readFileSync(file, 'utf8')).channels || {}
    } catch {}
  }

  get size () { return Object.keys(this.channels).length }

  save () {
    mkdirSync(dirname(this.file), { recursive: true })
    const sorted = Object.fromEntries(Object.entries(this.channels).sort(([a], [b]) => a.localeCompare(b)))
    writeFileSync(this.file, JSON.stringify({ updated: new Date().toISOString(), channels: sorted }, null, 2) + '\n')
  }

  /**
   * Every channel is offered on both CONFIGURATION and PLAY and marked optional:
   * NeoForge silently disables optional client channels the server doesn't have,
   * so we never need to know which protocol a channel belongs to.
   */
  components () {
    return Object.entries(this.channels).map(([id, c]) => ({ id, version: c.version, flow: c.flow, optional: true }))
  }

  /**
   * Updates the store from a decoded setup-failed payload.
   * @returns {{changed: boolean, unknown: string[]}}
   */
  learn (failures) {
    let changed = false
    const unknown = []
    for (const [id, component] of Object.entries(failures)) {
      const reason = failureReason(component)
      const key = typeof reason === 'object' && reason ? reason.key.replace(PREFIX, '') : String(reason)
      const args = (reason && reason.args) || []
      const entry = this.channels[id] || { version: '1', flow: null }

      if (key === 'missing.server.client') {
        // Server requires it, we didn't offer it.
        if (!this.channels[id]) { this.channels[id] = entry; changed = true }
      } else if (key === 'version.mismatch') {
        // args: [clientVersion, serverVersion]
        const serverVersion = String(args[1] ?? '')
        if (entry.version !== serverVersion) { entry.version = serverVersion; this.channels[id] = entry; changed = true }
      } else if (key === 'flow.client.missing' || key === 'flow.client.mismatch') {
        // args[0] is the server's flow
        const flow = String(args[0]).toUpperCase()
        if (entry.flow !== flow) { entry.flow = flow; this.channels[id] = entry; changed = true }
      } else if (key === 'flow.server.missing') {
        // We sent a flow the server doesn't have.
        if (entry.flow !== null) { entry.flow = null; changed = true }
      } else if (key === 'missing.client.server') {
        // We offered a channel the server doesn't know. Shouldn't happen with optional=true.
        if (this.channels[id]) { delete this.channels[id]; changed = true }
      } else {
        unknown.push(`${id}: ${JSON.stringify(reason)}`)
      }
    }
    return { changed, unknown }
  }
}
