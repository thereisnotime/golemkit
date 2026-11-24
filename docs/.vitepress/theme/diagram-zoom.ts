// Adds an expand button to every rendered mermaid diagram. It opens a full-screen view where the
// diagram can be zoomed (wheel, buttons, +/- keys) and panned (drag); Esc or the backdrop closes it.
export function setupDiagramZoom (): void {
  const decorate = () => {
    document.querySelectorAll<HTMLElement>('.mermaid').forEach(box => {
      // the mermaid plugin re-renders a diagram's innerHTML after it first appears, which drops a
      // button added earlier: check for the button itself, not a "done" flag on the box
      if (!box.querySelector('svg') || box.querySelector(':scope > .diagram-zoom-btn')) return
      box.classList.add('zoomable-diagram')
      if (!box.dataset.zoomReady) {
        box.dataset.zoomReady = '1'
        box.addEventListener('dblclick', () => open(box))
      }
      const btn = document.createElement('button')
      btn.className = 'diagram-zoom-btn'
      btn.type = 'button'
      btn.title = 'Open full screen (zoom and pan)'
      btn.setAttribute('aria-label', 'Open diagram full screen')
      btn.textContent = '⤢'
      btn.addEventListener('click', e => { e.stopPropagation(); open(box) })
      box.appendChild(btn)
    })
  }
  const open = (box: HTMLElement) => {
    const svg = box.querySelector('svg')
    if (!svg) return
    const overlay = document.createElement('div')
    overlay.className = 'diagram-overlay'
    overlay.innerHTML = `<div class="diagram-toolbar">
      <button type="button" data-z="in" title="Zoom in">+</button>
      <button type="button" data-z="out" title="Zoom out">−</button>
      <button type="button" data-z="reset" title="Fit">Fit</button>
      <button type="button" data-z="close" title="Close (Esc)">✕</button></div>
      <div class="diagram-stage"></div>`
    const stage = overlay.querySelector<HTMLElement>('.diagram-stage')!
    const clone = svg.cloneNode(true) as SVGSVGElement
    clone.removeAttribute('width'); clone.removeAttribute('height')
    clone.style.maxWidth = 'none'
    stage.appendChild(clone)
    document.body.appendChild(overlay)
    document.body.style.overflow = 'hidden'
    let scale = 1, x = 0, y = 0
    const fit = () => {
      const vb = clone.viewBox.baseVal
      const w = vb && vb.width ? vb.width : clone.getBoundingClientRect().width
      const h = vb && vb.height ? vb.height : clone.getBoundingClientRect().height
      clone.style.width = `${w}px`; clone.style.height = `${h}px`
      scale = Math.min((stage.clientWidth - 40) / w, (stage.clientHeight - 40) / h, 4)
      x = (stage.clientWidth - w * scale) / 2; y = (stage.clientHeight - h * scale) / 2
      apply()
    }
    const apply = () => { clone.style.transform = `translate(${x}px, ${y}px) scale(${scale})` }
    const zoomAt = (factor: number, cx = stage.clientWidth / 2, cy = stage.clientHeight / 2) => {
      const next = Math.min(12, Math.max(0.1, scale * factor))
      x = cx - (cx - x) * (next / scale); y = cy - (cy - y) * (next / scale); scale = next; apply()
    }
    const close = () => { overlay.remove(); document.body.style.overflow = ''; window.removeEventListener('keydown', onKey) }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      else if (e.key === '+' || e.key === '=') zoomAt(1.2)
      else if (e.key === '-') zoomAt(1 / 1.2)
      else if (e.key === '0') fit()
    }
    window.addEventListener('keydown', onKey)
    overlay.querySelector('.diagram-toolbar')!.addEventListener('click', e => {
      const z = (e.target as HTMLElement).dataset.z
      if (z === 'in') zoomAt(1.25); else if (z === 'out') zoomAt(1 / 1.25); else if (z === 'reset') fit(); else if (z === 'close') close()
    })
    stage.addEventListener('wheel', e => {
      e.preventDefault()
      const r = stage.getBoundingClientRect()
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top)
    }, { passive: false })
    let drag: { sx: number, sy: number, ox: number, oy: number } | null = null
    stage.addEventListener('pointerdown', e => { drag = { sx: e.clientX, sy: e.clientY, ox: x, oy: y }; stage.setPointerCapture(e.pointerId); stage.classList.add('dragging') })
    stage.addEventListener('pointermove', e => { if (!drag) return; x = drag.ox + e.clientX - drag.sx; y = drag.oy + e.clientY - drag.sy; apply() })
    stage.addEventListener('pointerup', () => { drag = null; stage.classList.remove('dragging') })
    overlay.addEventListener('click', e => { if (e.target === overlay) close() })
    requestAnimationFrame(fit)
  }
  // mermaid renders after navigation and lazily: watch the page for new diagrams
  new MutationObserver(() => decorate()).observe(document.body, { childList: true, subtree: true })
  decorate()
}
