# Tasks
- [x] Baseline on a local vanilla 1.21.1 server: node floor, bare Mineflayer (with and without pathfinder), golemkit minimal, Pax copy, fleet of 2 vs 2 processes
- [x] Bisect imports (process.memoryUsage per import, smaps, heap snapshot, loaded module list)
- [x] Lazy-load the LLM SDKs (anthropic, claude-subscription, MCP bridge)
- [x] Compile cache in the justfile and the image, flushed after start
- [x] V8 semi-space flag in the justfile and the image, measured with GC time
- [x] memlog GC count and time, unit test
- [x] Docs: deployment (memory table), config reference (GOLEM_NODE_FLAGS, NODE_COMPILE_CACHE)
