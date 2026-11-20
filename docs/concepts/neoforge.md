# NeoForge support

Mineflayer only speaks the vanilla protocol. A NeoForge server rejects vanilla clients when
its mods register network channels (any content mod does), so mc-buddy adds a NeoForge layer
in `src/core/neoforge/`. Skills and brains never see it.

Everything here is written against NeoForge's 1.21.1 source
(`neoforged/NeoForge`, branch `1.21.1`, `network/payload/` and `network/registration/`).

## 1. Channel negotiation

During the configuration phase the server sends an empty `neoforge:register` query and the
client answers with every payload channel it supports, per protocol (configuration / play),
with version, direction (flow) and an optional flag. The server compares lists and either
accepts (`neoforge:network`) or sends `neoforge:modded_network_setup_failed` with a reason per
channel, then disconnects.

The bot can't know a modpack's channels in advance, so it **learns them from the failures**:

1. first attempt offers nothing; the server lists every required channel as missing
2. second attempt offers them; the server reports the expected flow for directional ones
3. third attempt fixes flows; the server reports versions that differ from the default
4. accepted

`ChannelStore` (`channelStore.ts`) applies each failure and caches the result in
`data/channels-<host>-<port>.json`, so later logins pass on the first try. When the modpack
changes, the bot relearns automatically; `just reset-channels` forces it.

Two tricks keep it simple:

- **Everything is offered as optional, on both protocols.** NeoForge silently disables
  optional client channels the server doesn't have, so the bot never needs to know which
  protocol a channel belongs to.
- **NeoForge's own configuration channels are always offered** with their real flows
  (registry sync, config files, data maps, extensible enums, feature flags). The server
  registers them as optional; without them its `CheckExtensibleEnums` task hangs.

## 2. Configuration tasks

After negotiation the server runs NeoForge's configuration tasks. `handshake.ts` answers:

| payload | reply |
|---|---|
| `neoforge:frozen_registry_sync_*` | `frozen_registry_sync_completed` when done |
| `neoforge:config_file` | (none, ignored) |
| `neoforge:known_registry_data_maps` | claims to know all of them (so mandatory ones don't kick us) |
| `neoforge:extensible_enum_data` | `extensible_enum_ack` |
| `neoforge:feature_flags` | `feature_flags_ack` |
| `c:version`, `c:register` | common networking v1 |

Then vanilla configuration finishes and the bot enters the world.

## 3. Unparseable packets

Item stacks carry data components, and modded items carry modded components. Components have
no length prefix, so a stack with an unknown component can't be skipped inside a packet. The
recipe list, the command tree and some inventory/equipment packets fail to parse.

protodef's deserializer turns a parse error into a stream error, which destroys the stream and
silently kills the connection. `tolerantParser.ts` patches `FullPacketParser` to drop the
packet and keep going. Skipped packets are logged once per packet id (all of them at debug
level).

Consequences: inventories and containers can be incomplete when they hold modded items; the
bot doesn't know recipes from the server (mineflayer uses minecraft-data's vanilla recipes).

## 4. Modded blocks

NeoForge appends modded block states after the vanilla ones, so vanilla state ids stay valid
and anything above the vanilla maximum is modded. prismarine-block would treat those as air,
so the bot would fall through Create casings. `modded.ts` maps them to a stand-in
`modded_block`: a solid, non-diggable full cube. Pathfinding treats machines as walls, which
is the safe default.

Unknown items show up as `modded#<id>` (`itemName()` in core helpers).

## Debugging a new server

```bash
MC_LOG_LEVEL=debug just probe
```

shows the negotiation rounds, accepted channel counts, skipped packet ids and the world
snapshot after spawn. If negotiation keeps failing with "nothing new learned", the log lists
the failure reasons it doesn't understand.
