# jemalloc by default

## Why
glibc's malloc keeps the native memory a busy bot used while scouting or pathing. On mc02 Pax
settled at 265 MB RSS with glibc and at 210 to 220 MB with jemalloc preloaded (native memory
outside the JS heap went from about 135 to about 90 MB).

## What changes
- `just run`, `just dev` and `just fleet` preload jemalloc when it is installed
  (`GOLEM_MALLOC=auto`, default); `GOLEM_MALLOC=system` keeps glibc, a path picks a library.
- The image installs `libjemalloc2` and sets `LD_PRELOAD`; `-e LD_PRELOAD=` turns it off.
