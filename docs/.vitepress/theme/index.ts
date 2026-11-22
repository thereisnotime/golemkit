// Docs theme: the default theme plus chat-phrase chips, a zoom view for mermaid diagrams and
// slot-machine words on the homepage.
import DefaultTheme from 'vitepress/theme'
import './custom.css'
import { setupDiagramZoom } from './diagram-zoom'
import { setupSlotWords } from './slot-words'

export default {
  extends: DefaultTheme,
  enhanceApp () {
    if (typeof window !== 'undefined') { setupDiagramZoom(); setupSlotWords() }
  }
}
