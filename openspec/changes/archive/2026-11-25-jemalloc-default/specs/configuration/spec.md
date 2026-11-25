## ADDED Requirements

### Requirement: Launcher malloc
The `run`, `dev` and `fleet` launchers SHALL preload jemalloc when it is installed and
`GOLEM_MALLOC` is unset or `auto`, SHALL use the system malloc when `GOLEM_MALLOC` is `system`,
and SHALL preload the given library when `GOLEM_MALLOC` is a path to an existing file. The
container image SHALL preload jemalloc unless `LD_PRELOAD` is overridden.

#### Scenario: jemalloc not installed
- **WHEN** `GOLEM_MALLOC` is `auto` and no jemalloc library is found
- **THEN** the bot starts with the system malloc and no error
