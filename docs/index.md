---
layout: home
hero:
  name: golemkit
  text: '<span class="slot" data-words="Minecraft:now|Luanti:soon|Bedrock:soon|Terraria:idea|Factorio:idea|Vintage Story:idea">Minecraft</span><br/>bots that pull their weight'
  tagline: 'A TypeScript framework for companions, bodyguards, NPCs and LLM agents, useful with or without an LLM. The core is game-agnostic; today it runs on <span class="slot" data-period="2200" data-words="NeoForge:now|Paper:try|vanilla:try|Spigot:try|Fabric:try|Forge:idea">NeoForge</span> Minecraft servers.'
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
      text: Roadmap
      link: /roadmap
    - theme: alt
      text: View on GitHub
      link: https://github.com/thereisnotime/golemkit
features:
  - icon: "<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' ><path d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' /><path d='M13 8H7' /><path d='M17 12H7' /></svg>"
    title: Talk to it in plain chat
    details: '"guard me", "find iron", "bring me 16 planks". Patterns, a local MiniLM model and an optional local LLM understand you with no cloud call; every layer is configurable and benchmarked.'
    link: /guide/intents
    linkText: Plain-language commands
  - icon: "<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' ><path d='M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' /><path d='m9 12 2 2 4-4' /></svg>"
    title: A bodyguard that helps
    details: Ranks threats by how close they are to you, deals with creepers first, holds fire when you're in the line, warns you and tosses you food. A third fewer hits in the mob-wave benchmark.
    link: /guide/behaviors
    linkText: Behaviours
  - icon: "<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' ><path d='M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z' /><path d='M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z' /><path d='M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4' /><path d='M17.599 6.5a3 3 0 0 0 .399-1.375' /><path d='M6.003 5.125A3 3 0 0 0 6.401 6.5' /><path d='M3.477 10.896a4 4 0 0 1 .585-.396' /><path d='M19.938 10.5a4 4 0 0 1 .585.396' /><path d='M6 18a4 4 0 0 1-1.967-.516' /><path d='M19.967 17.484A4 4 0 0 1 18 18' /></svg>"
    title: LLM brain on your subscription
    details: Claude or Codex logins kept apart from your own setup, or an API. Goals it works through alone, budgets, token tracking, and an NPC fallback when the quota runs out.
    link: /guide/llm-brain
    linkText: LLM brain
  - icon: "<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' ><path d='M14.531 12.469 6.619 20.38a1 1 0 1 1-3-3l7.912-7.912' /><path d='M15.686 4.314A12.5 12.5 0 0 0 5.461 2.958 1 1 0 0 0 5.58 4.71a22 22 0 0 1 6.318 3.393' /><path d='M17.7 3.7a1 1 0 0 0-1.4 0l-4.6 4.6a1 1 0 0 0 0 1.4l2.6 2.6a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4z' /><path d='M19.686 8.314a12.501 12.501 0 0 1 1.356 10.225 1 1 0 0 1-1.751-.119 22 22 0 0 0-3.393-6.319' /></svg>"
    title: Looks after itself
    details: Reflexes, adaptive weapons and shields, skilled-player combat techniques, cover against archers, tool upgrades, a food ladder that searches wider and grows its own farm, climbing out of caves, swimming up for air, getting home without flip-flopping.
    link: /guide/progression
    linkText: Tool progression
  - icon: "<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' ><path d='m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z' /><circle cx='12' cy='12' r='10' /></svg>"
    title: Finds and fetches
    details: Ores, mobs, water, villages and biomes. Brings items from its own chests, crafting, smelting or gathering, and recovers your drops after a death.
    link: /guide/search
    linkText: Search and fetch
  - icon: "<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' ><path d='m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9' /><path d='m18 15 4-4' /><path d='m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5' /></svg>"
    title: Builds for you
    details: YAML blueprints, imports from .schem, .litematic and .nbt, a licensed blueprint library, roads and stairs between buildings, optional WorldEdit.
    link: /guide/goals-and-building
    linkText: Goals and building
  - icon: "<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' ><path d='M12 22v-5' /><path d='M9 8V2' /><path d='M15 8V2' /><path d='M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z' /></svg>"
    title: Gets into modded servers
    details: Learns a NeoForge server's mod channels on its own, answers its config tasks and survives modded packets. Vanilla and Paper work too.
    link: /concepts/neoforge
    linkText: NeoForge support
  - icon: "<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' ><line x1='21' x2='14' y1='4' y2='4' /><line x1='10' x2='3' y1='4' y2='4' /><line x1='21' x2='12' y1='12' y2='12' /><line x1='8' x2='3' y1='12' y2='12' /><line x1='21' x2='16' y1='20' y2='20' /><line x1='12' x2='3' y1='20' y2='20' /><line x1='14' x2='14' y1='2' y2='6' /><line x1='8' x2='8' y1='10' y2='14' /><line x1='16' x2='16' y1='18' y2='22' /></svg>"
    title: Configurable while it runs
    details: Variants, profiles, armable behaviours and live toggles. Change how a bot fights, listens or builds from chat, without a restart.
    link: /guide/live-config
    linkText: Live config
  - icon: "<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' ><path d='M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4' /><path d='M2 6h4' /><path d='M2 10h4' /><path d='M2 14h4' /><path d='M2 18h4' /><path d='M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z' /></svg>"
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
  A --> M["game adapter<br/>Mineflayer + NeoForge, Paper or vanilla platform"]
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

<p class="home-footnote">Icons from <a href="https://lucide.dev">Lucide</a> (ISC). Open source under the <a href="https://github.com/thereisnotime/golemkit/blob/main/LICENSE">LGPL-3.0</a>.</p>
