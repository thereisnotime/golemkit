## ADDED Requirements

### Requirement: Game-agnostic core
The core SHALL NOT import Mineflayer or any game client; it SHALL reach the game only through a `GameAdapter`.

#### Scenario: Lint rule
- **WHEN** a file under `src/core`, `src/llm`, `src/context` or `src/brains` imports `mineflayer` or `prismarine-*`
- **THEN** the check fails

### Requirement: Minecraft Java adapter without behaviour change
The Minecraft Java adapter SHALL provide the current behaviour, and existing variants and profiles SHALL run unchanged.

#### Scenario: Same results
- **WHEN** the test suite and the guard and intent benchmarks run before and after the split
- **THEN** all tests pass and the benchmark numbers stay within their run-to-run variance

### Requirement: Capability gating
Actions and behaviours SHALL declare the capabilities they need, and an agent SHALL only offer those its adapter supports.

#### Scenario: Game without digging
- **WHEN** an adapter does not declare `dig`
- **THEN** dig actions are not registered and the LLM never sees them as tools
