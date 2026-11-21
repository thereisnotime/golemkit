---
layout: home
hero:
  name: mc-buddy
  text: Minecraft bots for NeoForge servers
  tagline: Player assistants, self-sufficient NPCs, LLM agents and staged scenes, on real protocol clients that start in a second.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Architecture
      link: /concepts/architecture
features:
  - title: Gets into modded servers
    details: Learns a NeoForge server's mod channels on its own, answers its config tasks and survives packets with modded data. Built and tested on a Create + Ars Nouveau pack.
  - title: One definition, three uses
    details: Every capability is an action with a zod schema. The same definition is a chat command, an LLM tool and a typed function.
  - title: Brains that share a body
    details: Chat commands, reflexes, NPC loops and LLMs run side by side. Priorities decide who moves the bot; interrupted tasks resume.
  - title: LLMs on your subscriptions
    details: Claude, Codex or OpenCode logins (isolated from your own setup), API keys, local models or the caveman proxy. Token tracking, budgets, truthful reporting, immersive mode.
  - title: Remembers what happened
    details: Every bot keeps a journal of deaths, damage, items, chat and actions with hourly and daily rollups, so it can answer "where did you die?" from facts.
  - title: Learns without an LLM in the loop
    details: The Apprentice turns an owner's instruction into a validated behaviour program once, then runs it with no LLM. Context packs and hooks add rules, memory and deterministic reactions.
  - title: Fleets across servers
    details: Run one bot or dozens, on one server or several, from a YAML file. Bots on the same server coordinate through a message bus and a shared blackboard.
---
