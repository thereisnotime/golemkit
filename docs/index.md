---
layout: home
hero:
  name: golemkit
  text: Minecraft bots that pull their weight
  tagline: A TypeScript framework for companions, bodyguards, NPCs and LLM agents. Real protocol clients on Mineflayer, first-class NeoForge support, useful with or without an LLM.
  image:
    src: /golem.svg
    alt: golemkit
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Talk to your bot
      link: /guide/intents
    - theme: alt
      text: View on GitHub
      link: https://github.com/thereisnotime/golemkit
features:
  - icon: 💬
    title: Talk to it in plain chat
    details: '"guard me", "find iron", "bring me 16 planks". Patterns, a local MiniLM model and an optional local LLM understand you with no cloud call; every layer is configurable and benchmarked.'
    link: /guide/intents
    linkText: Plain-language commands
  - icon: 🛡️
    title: A bodyguard that helps
    details: Ranks threats by how close they are to you, deals with creepers first, holds fire when you're in the line, warns you and tosses you food. A third fewer hits in the mob-wave benchmark.
    link: /guide/behaviors
    linkText: Behaviours
  - icon: 🧠
    title: LLM brain on your subscription
    details: Claude or Codex logins kept apart from your own setup, or an API. Goals it works through alone, budgets, token tracking, and an NPC fallback when the quota runs out.
    link: /guide/llm-brain
    linkText: LLM brain
  - icon: ⛏️
    title: Looks after itself
    details: Reflexes, adaptive weapons and shields, tool upgrades, food scouting and farming, climbing out of caves, swimming up for air, getting home without flip-flopping.
    link: /guide/progression
    linkText: Tool progression
  - icon: 🧭
    title: Finds and fetches
    details: Ores, mobs, water, villages and biomes. Brings items from its own chests, crafting, smelting or gathering, and recovers your drops after a death.
    link: /guide/search
    linkText: Search and fetch
  - icon: 🏗️
    title: Builds for you
    details: YAML blueprints, imports from .schem, .litematic and .nbt, a licensed blueprint library, roads and stairs between buildings, optional WorldEdit.
    link: /guide/goals-and-building
    linkText: Goals and building
  - icon: 🔌
    title: Gets into modded servers
    details: Learns a NeoForge server's mod channels on its own, answers its config tasks and survives modded packets. Vanilla and Paper work too.
    link: /concepts/neoforge
    linkText: NeoForge support
  - icon: 🎛️
    title: Configurable while it runs
    details: Variants, profiles, armable behaviours and live toggles. Change how a bot fights, listens or builds from chat, without a restart.
    link: /guide/live-config
    linkText: Live config
  - icon: 📓
    title: Remembers what happened
    details: A journal of deaths, items, actions and LLM tokens with daily rollups, so a bot answers "where did you die?" from facts.
    link: /guide/journal
    linkText: Event journal
---

## Up and running in a minute

```bash
git clone https://github.com/thereisnotime/golemkit.git && cd golemkit
asdf install && just setup      # Node 26 + just, npm ci, creates .env
$EDITOR .env                    # MC_HOST, MC_OWNER, ...
just run                        # the buddy bot; say "help" to it in game
```

Then pick a bigger bot: `just run pax` is an LLM companion, `just bots` lists the rest, and
[writing a variant](/guide/writing-a-bot) shows how to make your own.

## How a bot is put together

```mermaid
flowchart TD
  C(["chat, events, the world"]) --> B["brains<br/>intents · reflexes · behaviours · LLM"]
  B --> L{"action lock<br/>priorities"}
  L --> A["actions<br/>goto · fight · collect · build ..."]
  A --> M["Mineflayer client<br/>+ NeoForge layer"]
  classDef a fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef d fill:#fef3c7,stroke:#d97706,color:#78350f
  classDef g fill:#dcfce7,stroke:#16a34a,color:#14532d
  class C a
  class B,A g
  class L d
  class M a
```

Every capability is one action with a zod schema: the same definition is a chat command, an LLM
tool and a typed function. Several brains run at once and share the body through priorities.
More in [Architecture](/concepts/architecture).

<p class="home-footnote">Open source under the <a href="https://github.com/thereisnotime/golemkit/blob/main/LICENSE">LGPL-3.0</a>.</p>
