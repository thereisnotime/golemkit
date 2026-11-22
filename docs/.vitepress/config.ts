import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

// Local docs site: `just docs` (dev server) or `just docs-build` (static HTML in docs/.vitepress/dist).
export default withMermaid(defineConfig({
  title: 'golemkit',
  description: 'Minecraft bot framework for NeoForge servers',
  cleanUrls: true,
  // '/' locally; the GitHub Pages workflow sets DOCS_BASE=/golemkit/ (the site lives under the repo name)
  base: process.env.DOCS_BASE || '/',
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: `${process.env.DOCS_BASE || '/'}favicon.svg` }]],
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
          { text: 'Plain-language commands', link: '/guide/intents' },
          { text: 'Goals and building', link: '/guide/goals-and-building' },
          { text: 'Roads and stairs', link: '/guide/roads' },
          { text: 'Tool progression and gathering', link: '/guide/progression' },
          { text: 'Finding and fetching', link: '/guide/search' },
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
