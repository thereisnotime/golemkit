---
name: come-to-me
description: "Go to the player who asked: come if visible, otherwise ask for coordinates and goto."
actions: [observe, come, goto]
---
1. observe. Is the player in `nearby`?
2. Visible: come (player = them). Reply "on my way" first only if it'll take a while.
3. Not visible: don't call come or guess coordinates. Reply asking for their x y z.
4. When they send coordinates: goto x y z (y is optional). It runs in the background: say you're on the way.
5. When the action ends (you'll get an event), tell them the real outcome: arrived, or stuck and where.
