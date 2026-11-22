## ADDED Requirements

### Requirement: Benchmark profiles
The benchmark SHALL offer a light profile and a fighting tester, and SHALL report the mean and a 95% interval per phase.

#### Scenario: Light profile
- **WHEN** the benchmark runs with `--profile light`
- **THEN** no more than 3 summoned mobs are alive at once

#### Scenario: Summary
- **WHEN** a phase ran 3 or more times
- **THEN** the summary shows mean, standard deviation and the interval for hits and deaths
