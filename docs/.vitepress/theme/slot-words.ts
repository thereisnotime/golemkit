// Slot-machine words: <span class="slot" data-words="Minecraft:now|Luanti:soon|...">Minecraft</span>
// cycles through the words with a vertical roll. ":now" / ":try" / ":soon" / ":idea" add a small status badge
// so the homepage never claims a game or platform works before it does. Respects reduced motion.
type Word = { text: string, status: string }

const BADGE: Record<string, string> = { now: 'works today', try: 'untested', soon: 'on the roadmap', idea: 'idea' }

function parse (spec: string): Word[] {
  return spec.split('|').map(w => {
    const [text, status = 'now'] = w.split(':')
    return { text: text!.trim(), status: status.trim() }
  }).filter(w => w.text)
}

function start (el: HTMLElement): void {
  const words = parse(el.dataset.words ?? '')
  if (words.length < 2) return
  el.dataset.slotReady = '1'
  el.textContent = ''
  const reel = document.createElement('span')
  reel.className = 'slot-reel'
  const word = document.createElement('span')
  word.className = 'slot-word'
  const badge = document.createElement('span')
  badge.className = 'slot-badge'
  reel.append(word)
  el.append(reel, badge)
  let i = 0
  const show = (w: Word) => {
    word.textContent = w.text
    word.dataset.status = w.status
    reel.dataset.status = w.status
    badge.textContent = BADGE[w.status] ?? w.status
    badge.dataset.status = w.status
  }
  show(words[0]!)
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const period = Number(el.dataset.period ?? 2600)
  const timer = window.setInterval(() => {
    if (!el.isConnected) { window.clearInterval(timer); return }
    i = (i + 1) % words.length
    show(words[i]!)
    if (reduced) return
    // restart the roll-in animation (a CSS keyframe, so a missed frame never leaves it hidden)
    word.classList.remove('slot-roll')
    void word.offsetWidth
    word.classList.add('slot-roll')
  }, period)
}

export function setupSlotWords (): void {
  const scan = () => document.querySelectorAll<HTMLElement>('.slot:not([data-slot-ready])').forEach(start)
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true })
  scan()
}
