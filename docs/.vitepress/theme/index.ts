// Docs theme: the default theme plus chat-phrase chips, a zoom view for mermaid diagrams,
// slot-machine words on the homepage and a scope badge (game-agnostic / Minecraft / NeoForge)
// at the top of each page. Personality on top: an animated hero golem, a "Pax says" line under
// each page, a reading-progress XP bar, a 404 page and a few easter eggs (see fun.ts).
import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import './custom.css'
import './fun.css'
import ScopeBadge from './ScopeBadge.vue'
import HeroGolem from './HeroGolem.vue'
import PaxSays from './PaxSays.vue'
import FunLayer from './FunLayer.vue'
import NotFound from './NotFound.vue'
import { setupDiagramZoom } from './diagram-zoom'
import { setupSlotWords } from './slot-words'
import { setupFun } from './fun'

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, {
    'doc-before': () => h(ScopeBadge),
    'doc-footer-before': () => h(PaxSays),
    'home-hero-image': () => h(HeroGolem),
    'not-found': () => h(NotFound),
    'layout-bottom': () => h(FunLayer)
  }),
  enhanceApp () {
    if (typeof window !== 'undefined') { setupDiagramZoom(); setupSlotWords(); setupFun() }
  }
}
