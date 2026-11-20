## Context

NeoForge 1.21.1 servers negotiate payload channels during the configuration phase. The server sends an empty `neoforge:register` query, the client answers with its channel map per protocol, and the server either replies `neoforge:network` (accepted) or `neoforge:modded_network_setup_failed` with a reason per channel, then disconnects.

## Decisions

- **Own handshake instead of `minecraft-protocol-forge`.** The community fork (enderliker) replies to the query with an empty map, which always fails. Our implementation follows the payload codecs in neoforged/NeoForge `1.21.1` directly.
- **Learn channels rather than ship a list.** Failure reasons carry the missing channel, the server's flow and the server's version, so 3–4 reconnects converge. Cached per host:port in `data/`. Survives modpack updates without code changes.
- **Offer every channel as optional on CONFIGURATION and PLAY.** NeoForge drops optional client channels the server doesn't have, so we never need to know which protocol a channel belongs to. NeoForge's own configuration channels are always offered with their real flows, otherwise `CheckExtensibleEnums` hangs sending to a channel we lack.
- **Claim to know all registry data maps**, so mandatory ones don't kick us; their play-phase sync is ignored.
- **Tolerant packet parser.** Item stacks with modded data components can't be skipped (no length prefix). protodef turns a parse error into a stream error that destroys the deserializer, so we patch `FullPacketParser._transform` to drop the packet and continue.
- **Unknown block states are full solid cubes** via a Proxy on `registry.blocksByStateId`. NeoForge appends modded states after vanilla, so vanilla ids stay valid.
- **Chat is rate limited** (≥1.1 s between lines, queue of 8): vanilla kicks with `disconnect.spam` after ~10 rapid lines.
- **No mineflayer-pvp**: it pulls mineflayer 2.x; a small fight loop is enough.

## Risks

- Skipped packets mean some inventory/equipment state may be missing or stale.
- Modded non-cube blocks (shafts, cogs) are treated as cubes, so paths may be suboptimal.
- Relies on offline-mode auth on mc02; Microsoft auth is supported but untested here.
