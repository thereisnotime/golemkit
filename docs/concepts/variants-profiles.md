---
scope: core
---

# Variants, profiles, instances, fleets

Five words cover how bots are defined, configured and run.

| term | what it is | where |
|---|---|---|
| **Variant** | a kind of bot: which skills it has, which brains decide, default persona | `variants/<name>.ts` |
| **[Profile](/guide/profiles)** | a saved, named instance config: variant + username, owners, server, LLM, settings | `profiles/<name>.yaml` |
| **Instance** | a running bot (an `Agent`), created from a profile or a variant | runtime |
| **[Fleet](/concepts/architecture#fleets-and-multiple-servers)** | a set of profiles/variants run together in one process, possibly on several servers | `fleets/<name>.yaml` |
| **Login** | an isolated LLM CLI login (the CLI's HOME, holding only its credentials) | `.auth/<login>` |

```mermaid
classDiagram
  direction TB
  class Variant {
    variants/name.ts
    skills[]
    brains[]
    persona
    defaults
  }
  class Profile {
    profiles/name.yaml
    variant
    username, owners
    server
    llm (model, login, listen)
    settings
  }
  class Fleet {
    fleets/name.yaml
    servers
    defaults
    entries[]
  }
  class Instance {
    Agent at runtime
    one identity
    reconnects
  }
  class Login {
    .auth/login
    isolated HOME
    CLI credentials
  }
  Profile --> Variant : uses
  Fleet --> Profile : lists
  Fleet --> Variant : lists
  Instance --> Profile : created from
  Instance --> Variant : or directly from
  Profile --> Login : llm.login
  style Variant fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  style Profile fill:#dcfce7,stroke:#16a34a,color:#14532d
  style Fleet fill:#fef3c7,stroke:#d97706,color:#78350f
  style Instance fill:#ede9fe,stroke:#7c3aed,color:#4c1d95
  style Login fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
```

## Examples in the repo

| variant | what it does | profiles using it |
|---|---|---|
| `buddy` | player assistant driven by `!commands` | `example` |
| `villager` | self-sufficient NPC (needs, routines, chores) | |
| `actor` | performs [scenes](/guide/scenes) with other actors | used by `fleets/scenes.example.yaml` |
| `companion` | LLM companion that talks and acts | `pax` (Sonnet 5.5, subscription token, obeys Robin) |

## How a name is resolved

`just run <name>` and fleet entries accept either a profile or a variant:

```mermaid
flowchart TD
  A["just run pax"] --> B{"profiles/pax.yaml<br/>exists?"}
  B -- yes --> C["load profile"] --> D["variant: companion<br/>variants/companion.ts"]
  B -- no --> E["variants/pax.ts"]
  D --> F["merge options<br/>env &lt; profile &lt; CLI flags"]
  E --> F
  F --> G(["Agent instance<br/>Pax on mc02"])
  classDef cmd fill:#f1f5f9,stroke:#475569,color:#0f172a
  classDef prof fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef vari fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef inst fill:#ede9fe,stroke:#7c3aed,color:#4c1d95
  class A cmd
  class C prof
  class D,E vari
  class G inst
```

## Precedence

Lowest to highest. Each layer only overrides what it sets.

```mermaid
flowchart TD
  E[".env / environment"] --> V["variant defaults<br/>(code)"] --> P["profile<br/>(profiles/*.yaml)"]
  P --> FD["fleet defaults"] --> FE["fleet entry"] --> C["CLI flags"]
  style E fill:#f1f5f9,stroke:#64748b,color:#0f172a
  style V fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  style P fill:#dcfce7,stroke:#16a34a,color:#14532d
  style FD fill:#fef3c7,stroke:#d97706,color:#78350f
  style FE fill:#fef3c7,stroke:#d97706,color:#78350f
  style C fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
```

`settings` and `settings.llm` merge one level deep, so a profile can change just the model
and keep the variant's other LLM options.

## When to make what

- **New behaviour or capabilities** (new brains, a different skill set): a new **variant**.
- **Same kind of bot, different identity/config** (another name, owner, model, server,
  persona): a new **profile**. No code.
- **Several bots at once**: a **fleet** listing profiles and/or variants.
- **A second LLM account**: a new **login** (`just llm-login claude --login .auth/alt`) and point
  a profile's `llm.login` at it.
