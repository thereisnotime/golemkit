# mc-buddy

Mineflayer companion bot for a NeoForge 1.21.1 server. Node (see `.tool-versions`), ESM, no build step.

- `src/neoforge/` is the NeoForge layer: `codec.js` (wire formats from neoforged/NeoForge branch `1.21.1`, `network/payload/`), `handshake.js` (configuration-phase replies), `channelStore.js` (learns required channels from setup-failed payloads), `tolerantParser.js` (drops packets with modded data instead of killing the stream).
- When changing the handshake, check the payload ID and codec in the NeoForge source for that branch; don't guess channel names (`neoforge:extensible_enum_ack`, `neoforge:feature_flags_ack`, not the long forms).
- `just check` before committing. `just probe` / `just chat-test` hit the real server; only run them when needed and keep them out of `npm test`.
- Don't add mineflayer plugins that pull an old mineflayer as a dependency (mineflayer-pvp does).
- Update the OpenSpec specs in `openspec/` when behaviour changes.
