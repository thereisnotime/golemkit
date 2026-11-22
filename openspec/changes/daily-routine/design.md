# Design

A routine is a list of time windows mapped to behaviours with options, run by the behaviours brain.
It reuses existing behaviours (farm_loop, deposit_when_full, keep_tools_upgraded, sleep_at_night)
plus a new `light_up_home`. Night handling defers to stay_safe so they don't fight.
