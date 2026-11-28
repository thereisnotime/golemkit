## ADDED Requirements

### Requirement: A mob the fight left is not re-engaged at once
A mob a defend run leaves for a chase refusal (down a drop, in liquid, in a dark cave) SHALL be skipped by the proactive defend reflex for 60 seconds unless it comes within 3 blocks.

#### Scenario: creeper in a hole
- **WHEN** defend left a creeper 6 blocks away because it is down a drop
- **THEN** the proactive reflex does not start defend on it again within the next minute
