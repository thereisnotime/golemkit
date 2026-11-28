## Why
Pax failed to make a chest with "need 8 cherry_planks" while carrying other wood: minecraft-data lists one recipe per plank type, so a mix of woods (or logs and no planks) never matched, though the server accepts any planks.

## What Changes
- Crafting recognises tag slots from the data (variants of one recipe with the same shape and result whose slots differ) and fills them with a mix of members, biggest stacks first.
- Short of a tag group, it first crafts a member from what it holds (planks from logs), then the item.
- The missing-ingredients message names the group ("need 3 more of any planks").
