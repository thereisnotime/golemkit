import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

// Local docs site: `just docs` (dev server) or `just docs-build` (static HTML in docs/.vitepress/dist).
export default withMermaid(defineConfig({
  title: 'golemkit',
  description: 'Game bot framework with a game-agnostic core; Minecraft Java on Mineflayer (NeoForge, Paper, vanilla) today',
  cleanUrls: true,
  // '/' locally; the GitHub Pages workflow sets DOCS_BASE=/golemkit/ (the site lives under the repo name)
  base: process.env.DOCS_BASE || '/',
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${process.env.DOCS_BASE || '/'}favicon.svg` }],
    ['link', { rel: 'apple-touch-icon', href: `${process.env.DOCS_BASE || '/'}apple-touch-icon.png` }],
    ['meta', { name: 'theme-color', content: '#14b8a6' }],
    // link previews (GitHub, Slack, Discord, X): absolute URLs, since crawlers don't resolve the base
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'golemkit' }],
    ['meta', { property: 'og:title', content: 'golemkit: game bots that pull their weight' }],
    ['meta', { property: 'og:description', content: 'A TypeScript framework for companions, bodyguards, NPCs and LLM agents on a game-agnostic core. Minecraft Java today, more games next. Useful with or without an LLM.' }],
    ['meta', { property: 'og:image', content: 'https://thereisnotime.github.io/golemkit/og.png' }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { property: 'og:url', content: 'https://thereisnotime.github.io/golemkit/' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: 'https://thereisnotime.github.io/golemkit/og.png' }]
  ],
  lastUpdated: false,
  srcExclude: ['**/README.md'],
  markdown: {
    // short double-quoted phrases in prose ("pax follow me") become chat chips; code, fences and
    // diagrams are separate tokens and are left alone
    config (md) {
      md.core.ruler.push('chat_phrases', state => {
        for (const block of state.tokens) {
          if (block.type !== 'inline' || !block.children) continue
          const out: typeof block.children = []
          for (const t of block.children) {
            if (t.type !== 'text' || !t.content.includes('"')) { out.push(t); continue }
            const re = /"([^"\n]{1,60})"/g
            let last = 0
            let m: RegExpExecArray | null
            while ((m = re.exec(t.content))) {
              if (m.index > last) { const a = new state.Token('text', '', 0); a.content = t.content.slice(last, m.index); out.push(a) }
              const open = new state.Token('html_inline', '', 0); open.content = '<span class="chat-phrase">'; out.push(open)
              const mid = new state.Token('text', '', 0); mid.content = m[1]!; out.push(mid)
              const close = new state.Token('html_inline', '', 0); close.content = '</span>'; out.push(close)
              last = m.index + m[0].length
            }
            if (last === 0) { out.push(t); continue }
            if (last < t.content.length) { const z = new state.Token('text', '', 0); z.content = t.content.slice(last); out.push(z) }
          }
          block.children = out
        }
      })
    }
  },
  themeConfig: {
    logo: '/golem.svg',
    socialLinks: [{ icon: 'github', link: 'https://github.com/thereisnotime/golemkit' }],
    footer: { message: 'Released under the LGPL-3.0 License.', copyright: 'golemkit contributors' },
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Concepts', link: '/concepts/architecture' },
      { text: 'Reference', link: '/reference/actions' },
      { text: 'Roadmap', link: '/roadmap' }
    ],
    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Running bots and fleets', link: '/guide/running' },
          { text: 'Profiles', link: '/guide/profiles' },
          { text: 'Feature toggles (live config)', link: '/guide/live-config' },
          { text: 'Deployment', link: '/guide/deployment' }
        ]
      },
      {
        text: 'Talking to bots',
        collapsed: false,
        items: [
          { text: 'Plain-language commands', link: '/guide/intents' },
          { text: 'LLM brain', link: '/guide/llm-brain' },
          { text: 'Context packs and evals', link: '/guide/context-pack' }
        ]
      },
      {
        text: 'Behaviour and protection',
        collapsed: false,
        items: [
          { text: 'Behaviours and bodyguard', link: '/guide/behaviors' },
          { text: 'NPC brain', link: '/guide/npc-brain' },
          { text: 'Self-improver', link: '/guide/self-improver' },
          { text: 'Scenes', link: '/guide/scenes' }
        ]
      },
      {
        text: 'Working in the world',
        collapsed: false,
        items: [
          { text: 'Tool progression and gathering', link: '/guide/progression' },
          { text: 'Finding and fetching', link: '/guide/search' },
          { text: 'Goals and building', link: '/guide/goals-and-building' },
          { text: 'Blueprint libraries', link: '/guide/blueprints' },
          { text: 'Roads and stairs', link: '/guide/roads' },
          { text: 'WorldEdit', link: '/guide/worldedit' }
        ]
      },
      {
        text: 'Extending',
        collapsed: true,
        items: [
          { text: 'Writing a variant', link: '/guide/writing-a-bot' },
          { text: 'Writing skills', link: '/guide/writing-skills' },
          { text: 'Writing brains', link: '/guide/writing-brains' }
        ]
      },
      {
        text: 'Observing',
        collapsed: true,
        items: [
          { text: 'Event journal', link: '/guide/journal' },
          { text: 'Logging', link: '/guide/logging' }
        ]
      },
      {
        text: 'Concepts',
        items: [
          { text: 'Architecture', link: '/concepts/architecture' },
          { text: 'Variants, profiles, fleets', link: '/concepts/variants-profiles' },
          { text: 'Movement, protection, combat', link: '/concepts/world' },
          { text: 'Combat research', link: '/concepts/combat-research' },
          { text: 'NeoForge support', link: '/concepts/neoforge' },
          { text: 'What is game-specific', link: '/concepts/scope' },
          { text: 'Game adapters', link: '/concepts/adapters' }
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
    // system fonts, not the site's Inter web font: mermaid measures labels when it renders, and if
    // Inter arrives later the text is wider than its box and gets cut off
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    flowchart: { useMaxWidth: true, padding: 14, wrappingWidth: 220, nodeSpacing: 40, rankSpacing: 50 },
    sequence: { useMaxWidth: true },
    state: { useMaxWidth: true },
    themeVariables: {
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      fontSize: '15px',
      primaryColor: '#e0f2fe',
      primaryBorderColor: '#0284c7',
      primaryTextColor: '#0c4a6e',
      lineColor: '#64748b',
      secondaryColor: '#fef3c7',
      tertiaryColor: '#ede9fe'
    }
  }
}))
