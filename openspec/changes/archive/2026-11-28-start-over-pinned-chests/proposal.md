## Why
Live: right after leaving, Pax's keep_fed walked back towards the old pantry at 559 69 -47. The chest is pinned in the profile (storage.chests), which start_over can't edit, and with no home the pantry check looks at configured chests within 160 blocks of the bot.

## What Changes
- Chests in settings.storage.chests within 256 blocks of the place `old_base` no longer count anywhere (configuredChests / configuredChestRoles); the old base is for reference only.
