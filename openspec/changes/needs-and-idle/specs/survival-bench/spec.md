## ADDED Requirements

### Requirement: Bad farm and needs metrics
With `--bad-farm` the benchmark SHALL seed the fresh bot's memory with a farm (farm:1, 9x9) on the ground under the start before it runs, so the `ice` scenario starts with a farm that is frozen over. Every result line SHALL carry `badFarm`, the `site` journal events of the run (`sites`), the need searches it started with their outcome (`searches`), the idle chores that ran (`choresRun`) and the farms it knows at the end (`farmsAtEnd`).

#### Scenario: Frozen farm
- **WHEN** the bench runs `--scenario ice --bad-farm --kit stone`
- **THEN** the result's `sites` lists farm:1 as bad (flooded) and `farmsAtEnd` no longer has farm:1
