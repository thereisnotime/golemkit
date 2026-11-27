## ADDED Requirements

### Requirement: Stuck projects say why
A project whose last sessions got nothing done SHALL show the last session's reason on its queue
line and in the status view; a big project waiting for an ok with no owner online SHALL say so;
the builder SHALL name attachments it found nothing to place against, and the survey SHALL leave
alone attachments whose support block holds something the bot may not change.

#### Scenario: Walkway at 42/44
- **WHEN** two ladders have no wall block to hang on
- **THEN** the walkway line says which ladder hangs on which block and the stage can finish

### Requirement: Wall repairs keep the gate door
The builder SHALL take a door out only when a cell still to build is closed in behind it.

#### Scenario: A wall block missing
- **WHEN** the walls stage is missing one wall block and the door is in
- **THEN** the door stays in while the block is placed
