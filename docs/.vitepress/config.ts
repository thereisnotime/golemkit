import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

// Local docs site: `just docs` (dev server) or `just docs-build` (static HTML in docs/.vitepress/dist).
export default withMermaid(defineConfig({
  title: 'mc-buddy',
  description: 'Minecraft bot framework for NeoForge servers',
  cleanUrls: true,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }]],
  lastUpdated: false,
  srcExclude: ['**/README.md'],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Concepts', link: '/concepts/architecture' },
      { text: 'Reference', link: '/reference/actions' }
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Running bots and fleets', link: '/guide/running' },
          { text: 'Profiles', link: '/guide/profiles' },
          { text: 'Feature toggles (live config)', link: '/guide/live-config' },
          { text: 'Writing a variant', link: '/guide/writing-a-bot' },
          { text: 'Writing skills', link: '/guide/writing-skills' },
          { text: 'Writing brains', link: '/guide/writing-brains' },
          { text: 'NPC brain', link: '/guide/npc-brain' },
          { text: 'Behaviours', link: '/guide/behaviors' },
          { text: 'LLM brain', link: '/guide/llm-brain' },
          { text: 'Goals and building', link: '/guide/goals-and-building' },
          { text: 'Tool progression and gathering', link: '/guide/progression' },
          { text: 'Blueprint libraries', link: '/guide/blueprints' },
          { text: 'WorldEdit', link: '/guide/worldedit' },
          { text: 'Self-improver', link: '/guide/self-improver' },
          { text: 'Context packs and evals', link: '/guide/context-pack' },
          { text: 'Logging', link: '/guide/logging' },
          { text: 'Event journal', link: '/guide/journal' },
          { text: 'Scenes', link: '/guide/scenes' },
          { text: 'Deployment', link: '/guide/deployment' }
        ]
      },
      {
        text: 'Concepts',
        items: [
          { text: 'Architecture', link: '/concepts/architecture' },
          { text: 'Variants, profiles, fleets', link: '/concepts/variants-profiles' },
          { text: 'Movement, protection, combat', link: '/concepts/world' },
          { text: 'NeoForge support', link: '/concepts/neoforge' }
        ]
      },
      {
        text: 'Reference',
        items: [
          { text: 'Skills', link: '/skills' },
          { text: 'Actions', link: '/reference/actions' },
          { text: 'CLI and just recipes', link: '/reference/cli' },
          { text: 'Configuration', link: '/reference/config' }
        ]
      }
    ],
    search: { provider: 'local' },
    outline: [2, 3]
  },
  // Mermaid pulls in a few CommonJS packages; pre-bundle them or the dev server serves a blank page.
  vite: {
    optimizeDeps: {
      include: ['mermaid', 'fastdom', 'dayjs', 'debug', '@braintree/sanitize-url', 'cytoscape', 'cytoscape-cose-bilkent']
    }
  },
  mermaid: {
    theme: 'base',
    themeVariables: {
      fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
      primaryColor: '#e0f2fe',
      primaryBorderColor: '#0284c7',
      primaryTextColor: '#0c4a6e',
      lineColor: '#64748b',
      secondaryColor: '#fef3c7',
      tertiaryColor: '#ede9fe'
    }
  }
}))
