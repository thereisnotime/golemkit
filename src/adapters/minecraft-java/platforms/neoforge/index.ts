// NeoForge servers: the configuration-phase channel negotiation (learned channels per server),
// the frozen registry sync (modded item and entity names), modded blocks as a solid stand-in,
// and a packet parser that skips what vanilla definitions can't read.
import { join } from 'node:path'
import type { ServerPlatform } from '../../platform.ts'
import { listFromEnv } from '../../../../core/definition.ts'
import { ChannelStore } from './channelStore.ts'
import { attachNeoForge } from './handshake.ts'
import { installTolerantParser } from './tolerantParser.ts'
import { RegistryCache, applyModdedRegistries, type RegistrySnapshot } from './registries.ts'
import { solidifyUnknownBlocks } from '../../modded.ts'
import type { ServerConfig } from '../../../../core/definition.ts'

export function neoforgePlatform (server: ServerConfig): ServerPlatform {
  const channels = new ChannelStore(join('data', `channels-${server.host}-${server.port}.json`))
  const registryCache = new RegistryCache(join('data', `registries-${server.host}-${server.port}.json`))
  return {
    name: 'neoforge',
    capabilities: ['mods'],
    install (ctx) {
      installTolerantParser((id, e) => ctx.log.trace(`skipped unparseable packet ${id}`, { error: e.message.slice(0, 160) }))
    },
    describe: () => `${channels.size} known NeoForge channels`,
    attach (bot, ctx) {
      attachNeoForge(bot._client, channels, m => ctx.log.debug(m))
      bot._client.on('neoforge_failed' as any, (failures: Record<string, unknown>) => {
        const { changed, unknown } = channels.learn(failures)
        channels.save()
        for (const u of unknown.slice(0, 10)) ctx.log.warn(`unhandled negotiation failure: ${u}`)
        ctx.log.info(`server rejected our channel list, ${changed ? 'learned from it' : 'nothing new learned'}`, { issues: Object.keys(failures).length, known: channels.size })
        ctx.end(changed ? 'learned' : 'ended', changed ? undefined : 'negotiation failed and nothing new to learn')
      })
    },
    afterPlugins (bot) {
      bot._client.on('neoforge_registry' as any, (snap: RegistrySnapshot) => registryCache.add(snap))
      bot._client.on('neoforge_registries_done' as any, () => registryCache.save())
    },
    onLogin (bot, ctx) {
      solidifyUnknownBlocks(bot.registry)
      // Modded item and entity names from the server's registry sync (or the cached copy).
      const hostile = [
        ...((ctx.settings.moddedHostile as string[] | undefined) ?? []),
        ...listFromEnv(process.env.MC_MODDED_HOSTILE)
      ]
      const r = applyModdedRegistries(bot.registry, registryCache, { hostile })
      if (r.items || r.entities) ctx.log.debug('modded registries applied', { items: r.items, entities: r.entities })
      if (r.mismatches.length) ctx.log.warn(`server ids differ from vanilla data for ${r.mismatches.length} entries, names may be wrong`, { first: r.mismatches.slice(0, 3) })
    }
  }
}
