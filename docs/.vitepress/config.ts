import { defineConfig } from 'vitepress'

// Local docs site: `just docs` (dev server) or `just docs-build` (static HTML in docs/.vitepress/dist).
export default defineConfig({
  title: 'mc-buddy',
  description: 'Minecraft bot framework for NeoForge servers',
  cleanUrls: true,
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
          { text: 'Writing a bot', link: '/guide/writing-a-bot' },
          { text: 'Writing skills', link: '/guide/writing-skills' },
          { text: 'Writing brains', link: '/guide/writing-brains' },
          { text: 'NPC brain', link: '/guide/npc-brain' },
          { text: 'Logging', link: '/guide/logging' },
          { text: 'Scenes', link: '/guide/scenes' },
          { text: 'Deployment', link: '/guide/deployment' }
        ]
      },
      {
        text: 'Concepts',
        items: [
          { text: 'Architecture', link: '/concepts/architecture' },
          { text: 'NeoForge support', link: '/concepts/neoforge' }
        ]
      },
      {
        text: 'Reference',
        items: [
          { text: 'Actions', link: '/reference/actions' },
          { text: 'CLI and just recipes', link: '/reference/cli' },
          { text: 'Configuration', link: '/reference/config' }
        ]
      }
    ],
    search: { provider: 'local' },
    outline: [2, 3]
  }
})
