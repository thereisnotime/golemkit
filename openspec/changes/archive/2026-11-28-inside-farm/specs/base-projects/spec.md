## ADDED Requirements

### Requirement: The farm plot grows to farming.plotSize
farm_plot SHALL keep an odd square from farming.plotMin (default 3) up to farming.plotSize (default 7)
inside the walls, a margin of 1 from them and clear of the gate. A kept plot smaller than plotSize
SHALL be grown to the biggest odd square that fits, a square holding the old plot first. The base's
own floor inside it counts as free; the storage and workshop rows, the inside mine's stairs and
hatch and columns with something standing on the floor (a bed, a chest, a table) SHALL stay out. The
new square SHALL be stored as the plot, so the floor project leaves it alone and base safety fills a
hole in it with dirt, and place farm_plot SHALL move to its centre.

#### Scenario: Pax's fortress
- **WHEN** the fortress at 560 67 -43 keeps a 3x3 plot at 557 -43, its floor is stone and nothing stands on it
- **THEN** farm_plot grows the plot to the 7x7 at 555 -45, which holds the old plot

#### Scenario: Nothing bigger fits
- **WHEN** every column around the plot is kept for something else
- **THEN** the plot stays as it is and the project notes there is no bigger free square
