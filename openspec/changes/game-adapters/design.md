# Design

## The interface

```ts
interface GameAdapter {
  readonly game: string                       // 'minecraft-java', 'minecraft-bedrock', ...
  readonly capabilities: Set<Capability>      // 'move', 'dig', 'place', 'inventory', 'combat', 'chat', ...
  connect (opts: AdapterConnectOptions): Promise<void>
  disconnect (reason?: string): Promise<void>
  self (): SelfState                          // position, health, food or the game's equivalents
  observe (): Observation                     // entities, nearby world summary, time, weather
  chat (text: string, to?: string): Promise<void>
  on<E extends keyof AdapterEvents> (event: E, fn: AdapterEvents[E]): void  // chat, hurt, death, spawn, kicked
}
```

- Observations are plain data with a shared shape for the parts every game has (self, players,
  nearby entities, chat) and a `game` section for the rest, which skills of that game read.
- Primitives stay inside the adapter's skills: an adapter ships actions (`goto`, `attack`,
  `collect`) built on its own client, registered through the same `defineAction` API.
- Capabilities gate actions and behaviours: a behaviour lists the capabilities it needs and the
  registry hides it on adapters that lack them.

## Migration

1. Move Mineflayer-specific code from `src/core` into `src/adapters/minecraft-java` behind the
   interface, keeping `src/core/index.ts` exports as re-exports so variants don't change.
2. Make `observe()`, the LLM tools and intents use the adapter's observation and capabilities.
3. Run the full test suite and the live benchmarks (`guard-bench`, `intents-bench`) before and
   after: numbers must not change.
4. Add the second adapter and the author guide.

## Risks

- Hidden coupling in brains (direct `agent.bot` use): found with a lint rule that forbids
  Mineflayer imports outside adapters.
- Observation shape churn: keep the shared part small and versioned.
