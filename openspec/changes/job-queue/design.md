# Design

Stored in agent storage, run by a small brain at player-request priority so owner commands still
win and reflexes still preempt. The intents parser gets a compound splitter for "then" and time
clauses. Failed jobs retry per the existing retry settings, then move on.
