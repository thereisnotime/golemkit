// Small easter eggs for the docs site, client-only (called from enhanceApp behind a window check).
// No sounds, no network, nothing stored. Animations ignore the OS reduced-motion setting on purpose (owner's call).
//
//   - up up down down left right left right b a: pixel confetti and a tiny golem walks by
//   - type "pax" anywhere outside a text field: the hero golem waves (or a toast on other pages)
//   - click the nav logo 5 times: a secret line
//   - copy a code block: "+1 code block picked up"
//   - a greeting in the browser console
import { golemSvg } from './golem-svg'

export type GolemAct = 'wave' | 'dance'


/** Shows a short toast (FunLayer.vue renders them). */
export function toast (text: string): void {
  window.dispatchEvent(new CustomEvent('golem:toast', { detail: text }))
}

/** Asks the hero golem to do something; false when there is no golem on the page to do it. */
export function golemAct (act: GolemAct, line?: string): boolean {
  return !window.dispatchEvent(new CustomEvent('golem:act', { detail: { act, line }, cancelable: true }))
}

const KONAMI = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a']
const COLORS = ['#22c55e', '#15803d', '#14b8a6', '#2dd4bf', '#a9b2bc', '#76808b', '#ef4444', '#facc15']

function typing (t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))
}

function confetti (): void {
  const box = document.createElement('div')
  box.className = 'fun-confetti'
  box.setAttribute('aria-hidden', 'true')
  for (let i = 0; i < 42; i++) {
    const b = document.createElement('span')
    const size = 6 + Math.round(Math.random() * 3) * 2
    b.style.cssText = `left:${Math.random() * 100}vw;width:${size}px;height:${size}px;background:${COLORS[i % COLORS.length]};` +
      `--drift:${(Math.random() - 0.5) * 160}px;--spin:${Math.round(Math.random() * 4) * 90}deg`
    // !important so VitePress's reduced-motion rule (1 ms animations) doesn't cut the fall short
    b.style.setProperty('animation-duration', `${1.4 + Math.random() * 1.2}s`, 'important')
    b.style.setProperty('animation-delay', `${Math.random() * 0.5}s`, 'important')
    box.append(b)
  }
  document.body.append(box)
  window.setTimeout(() => box.remove(), 3400)
}

function walker (): void {
  if (document.querySelector('.golem-walker')) return
  const w = document.createElement('div')
  w.className = 'golem-walker'
  w.setAttribute('aria-hidden', 'true')
  w.innerHTML = golemSvg('walker')
  w.addEventListener('animationend', e => { if (e.target === w) w.remove() })
  document.body.append(w)
}

let greeted = false
function greet (): void {
  if (greeted) return
  greeted = true
  const art = [
    '      ,*.',
    '  .--[###]--.',
    '  | [o]  [o] |',
    '  |    ##    |   golemkit',
    '  |  ======  |   game bots that pull their weight',
    "  '----------'"
  ].join('\n')
  console.log(`%c${art}`, 'color:#14b8a6;font-family:ui-monospace,monospace;font-size:12px;line-height:1.3')
  console.log('%chi, fellow builder. the source is at https://github.com/thereisnotime/golemkit\n' +
    'agents and humans: read AGENTS.md before changing anything. and maybe try a certain famous cheat code here.',
  'color:inherit;font-size:12px')
}

export function setupFun (): void {
  greet()
  let seq: string[] = []
  let word = ''
  window.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return
    const k = e.key.toLowerCase()
    seq = [...seq, k].slice(-KONAMI.length)
    if (seq.join() === KONAMI.join()) {
      seq = []
      toast('cheat code accepted: +1 golem')
      golemAct('dance', 'is this... a dance party?')
      confetti(); walker()
    }
    word = (word + (k.length === 1 ? k : ' ')).slice(-3)
    if (word === 'pax') {
      word = ''
      if (!golemAct('wave', 'you called? *waves*')) toast('Pax waves at you from the home page')
    }
  })

  let clicks = 0
  let since = 0
  let copies = 0
  document.addEventListener('click', e => {
    const t = e.target as HTMLElement | null
    if (!t?.closest) return
    if (t.closest('.VPNavBarTitle a')) {
      const now = Date.now()
      clicks = now - since < 2500 ? clicks + 1 : 1
      since = now
      if (clicks === 5) { clicks = 0; toast('five clicks. golems are just rocks that found a job.') }
    }
    if (t.closest('.vp-doc button.copy, .vp-code-group button.copy')) {
      copies++
      toast(copies % 10 === 0 ? `+1 code block picked up (${copies} in your inventory, nice)` : '+1 code block picked up')
    }
  }, true)
}
