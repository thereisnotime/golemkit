// Docs theme: the default theme plus chat-phrase chips and a zoom view for mermaid diagrams.
import DefaultTheme from 'vitepress/theme'
import './custom.css'
import { setupDiagramZoom } from './diagram-zoom'

export default {
  extends: DefaultTheme,
  enhanceApp () {
    if (typeof window !== 'undefined') setupDiagramZoom()
  }
}
