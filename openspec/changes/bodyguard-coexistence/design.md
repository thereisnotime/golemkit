# Design

The behaviour already scores 45 without a threat; with `yieldToLlm` it uses priority npc for that
score and keeps behavior priority for threats. `stay_safe` reads the escort state's last-seen
time instead of the online flag.
