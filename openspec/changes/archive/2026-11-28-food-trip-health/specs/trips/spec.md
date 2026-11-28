## ADDED Requirements

### Requirement: Food trips when health can't come back
A food trip SHALL need only `trips.foodMinHealth` health (default 6) when the food bar is under 18, since health does not regenerate by waiting then; other trips and well-fed food trips keep `trips.minHealth`.

#### Scenario: hurt and hungry
- **WHEN** health is 6, food 12, and keep_fed wants a trip to an animal spot
- **THEN** the trip leaves

#### Scenario: hurt but fed
- **WHEN** health is 6 and food 18
- **THEN** the food trip waits for health 12
