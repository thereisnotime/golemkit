// Docs theme: the default theme plus chat-phrase chips, a zoom view for mermaid diagrams,
// slot-machine words on the homepage and a scope badge (game-agnostic / Minecraft / NeoForge)
// at the top of each page.
import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import './custom.css'
import ScopeBadge from './ScopeBadge.vue'
import { setupDiagramZoom } from './diagram-zoom'
import { setupSlotWords } from './slot-words'

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { 'doc-before': () => h(ScopeBadge) }),
  enhanceApp () {
    if (typeof window !== 'undefined') { setupDiagramZoom(); setupSlotWords() }
  }
}
