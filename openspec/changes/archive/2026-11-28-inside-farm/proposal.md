## Why
Pax built a fortress (origin 560 67 -43, interior 13x13, stone floor) but the farm_plot project reserved only a 3x3 and never refit it. The plot farm planted 7 dry wheat, Pax is starving, and every start_farm outside fails ("no flat grass next to water within 96 blocks, no water bucket"). The owner wants it to farm properly inside the walls.

## What Changes
- New knobs `farming.plotSize` (wanted side, odd, 3-11, default 7), `farming.plotMin` (default 3) and `farming.plotSeedRadius` (default 32). farm_plot fits odd squares from plotMin up to plotSize.
- A plot smaller than plotSize is grown: a bigger square inside the walls, preferring one that holds the old plot. The base's floor in it counts as free; storage and workshop rows, the inside mine's stairs and hatch, the gate, anything standing on the floor (beds, chests, tables) and a margin of 1 from the walls stay out. The new square is stored as the plot (floor and base safety follow it) and place farm_plot moves to its centre.
- The plot farm extends its farm (farm:2 keeps its name) onto the grown plot: the food source registry runs plot_farm again when the plot outgrows its farm.
- Water for a plot of 5 and up: water in reach, else a water bucket carried or from a container, else carried ice, else an empty bucket filled at water, else a bucket crafted from 3 iron ingots and filled, else dry. The result says which.
- Seeds: short of what the plot can take, chests first, then grass within plotSeedRadius of home (not protected, not by somebody's build). Dirt for the stone cells comes from chests, then the material sources.
