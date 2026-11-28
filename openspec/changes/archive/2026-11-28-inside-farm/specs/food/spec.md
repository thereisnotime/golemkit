## MODIFIED Requirements

### Requirement: The base's farm plot
plot_farm SHALL turn the plot kept by the farm_plot base project into a farm when farming.plot is
on (default). With farming.plotWater auto (default) it SHALL use water within 4 blocks of every cell
(at its height or one above); on a plot of 5 and up it SHALL then pour water in the middle from a
water bucket it carries, one from a container it may take from, carried ice broken without Silk
Touch, an empty bucket filled at water near home, or a bucket crafted from 3 iron ingots (carried or
stored) and filled, in that order; a smaller plot keeps water in reach, else ice; without any of
these it SHALL make a dry plot with a torch in the middle. The result SHALL say where the water came
from or why there is none. Short of seeds for the cells the plot can take, it SHALL take them from
its chests, then break grass within farming.plotSeedRadius (default 32) of home, outside protected
areas and away from somebody's build. It SHALL till only as many cells as it has seeds and plant
each at once. It SHALL put torches up until every crop cell has light 9 or more, and in a cold biome
under the sky a torch close enough to give the middle water light 10. Stone or sand cells SHALL be
swapped for dirt only with farming.plotSwap on, with dirt from its inventory, its chests or the
material sources. When the plot grew past its plot farm, the food source SHALL run plot_farm again
and the farm SHALL keep its name and be extended onto the new square. The farm SHALL be tended like
any farm but never grown past the plot.

#### Scenario: Pax's plot
- **WHEN** the plot is grass inside open walls in a snowy biome, there is no water near and no ice item, and it has 3 seeds and torches
- **THEN** it puts a torch in the middle, tills and plants 3 cells and saves the farm as a dry plot

#### Scenario: A grown plot with a water bucket in a chest
- **WHEN** the plot grew from 3x3 to 7x7 around farm:2, a chest at home holds a water bucket and the plot has no water in reach
- **THEN** plot_farm takes the bucket, pours the water in the middle, plants the new cells and saves farm:2 as a 7x7 plot with bucket water

#### Scenario: No bucket, two iron ingots
- **WHEN** a 7x7 plot has no water in reach and the bot has no bucket, no ice and 2 iron ingots
- **THEN** the plot is dry and the result says "no water bucket, no bucket and 2 iron ingots (3 make one), no ice"
