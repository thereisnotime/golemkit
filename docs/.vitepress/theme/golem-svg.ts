// Builds an inline, animatable copy of docs/public/golem.svg: the same pixels, split into groups
// (body, flower, eyes) so CSS can blink the eyes, sway the flower and move the gaze. Pure string
// work, so it renders the same on the server and in the browser.
import raw from '../../public/golem.svg?raw'

type Rect = { x: number, y: number, w: number, h: number, fill: string }

const EYE = new Set(['#2dd4bf', '#ccfbf1'])
const FLOWER = new Set(['#ef4444', '#facc15', '#15803d'])
const SOCKET = '#3f4650'

const rects: Rect[] = [...raw.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="(#[0-9a-f]{6})"\/>/g)]
  .map(m => ({ x: +m[1]!, y: +m[2]!, w: +m[3]!, h: +m[4]!, fill: m[5]! }))

const draw = (list: Rect[]) => list.map(r => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.fill}"/>`).join('')
const isEye = (r: Rect) => EYE.has(r.fill)
const isFlower = (r: Rect) => r.y <= 2 && r.x >= 19 && r.x <= 22 && FLOWER.has(r.fill)

const body = draw(rects.filter(r => !isEye(r) && !isFlower(r)))
const flower = draw(rects.filter(isFlower))
const eyes = draw(rects.filter(isEye))

/**
 * The golem as an SVG string. `id` keeps the glow filter unique per instance; `extra` is drawn on
 * top (the 404 lantern), `width` widens the view box to make room for it.
 */
export function golemSvg (id: string, opts: { extra?: string, width?: number } = {}): string {
  const w = opts.width ?? 32
  return `<svg class="golem-svg" viewBox="0 0 ${w} 27" shape-rendering="crispEdges" aria-hidden="true" focusable="false">` +
    `<defs><filter id="${id}-glow" x="-50%" y="-150%" width="200%" height="400%"><feGaussianBlur stdDeviation="0.9"/></filter></defs>` +
    `<g class="g-body">${body}</g>` +
    `<g class="g-flower">${flower}</g>` +
    // dark sockets behind the eyes, so a blink or a glance never shows a hole
    `<rect x="7" y="12" width="5" height="2" fill="${SOCKET}"/><rect x="20" y="12" width="5" height="2" fill="${SOCKET}"/>` +
    `<g class="g-look"><g class="g-eyes"><g class="g-glow" filter="url(#${id}-glow)">${eyes}</g>${eyes}</g></g>` +
    (opts.extra ?? '') +
    '</svg>'
}
