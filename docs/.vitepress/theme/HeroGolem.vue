<script setup lang="ts">
// The homepage golem (replaces the hero image, same size and place). It blinks, its flower sways,
// its eyes follow the pointer a little, and pressing it shows something Pax really says in game.
// The SVG is rendered on the server too; everything interactive starts in onMounted.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { golemSvg } from './golem-svg'
import { QUIPS, shuffleBag } from './pax-lines'
import { reducedMotion, type GolemAct } from './fun'

const svg = golemSvg('hero')
const root = ref<HTMLButtonElement>()
const line = ref('')
const shown = ref(false)
const mood = ref<'' | 'poke' | GolemAct>('')
const next = shuffleBag(QUIPS)
let hideTimer = 0
let moodTimer = 0
let frame = 0

function say (text: string): void {
  line.value = text
  shown.value = true
  window.clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => { shown.value = false }, 4200)
}

function act (m: typeof mood.value, ms: number): void {
  mood.value = ''
  window.clearTimeout(moodTimer)
  // restart the animation even when the same one is still running
  requestAnimationFrame(() => {
    mood.value = m
    moodTimer = window.setTimeout(() => { mood.value = '' }, ms)
  })
}

function poke (): void {
  say(next())
  act('poke', 260)
}

function onAct (e: Event): void {
  const { act: a, line: l } = (e as CustomEvent<{ act: GolemAct, line?: string }>).detail
  e.preventDefault()
  act(a, a === 'dance' ? 2000 : 1300)
  if (l) say(l)
}

// gaze: up to half a pixel each way, in quarter-pixel steps so it stays pixel art
function onMove (e: PointerEvent): void {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    const el = root.value
    const look = el?.querySelector('.g-look')
    if (!el || !look) return
    const r = el.getBoundingClientRect()
    const q = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 2) / 4
    const dx = q((e.clientX - (r.left + r.width / 2)) / 360)
    const dy = q((e.clientY - (r.top + r.height / 2)) / 360) * 0.6
    look.setAttribute('transform', `translate(${dx} ${dy})`)
  })
}

onMounted(() => {
  window.addEventListener('golem:act', onAct)
  if (!reducedMotion()) window.addEventListener('pointermove', onMove, { passive: true })
})
onBeforeUnmount(() => {
  window.removeEventListener('golem:act', onAct)
  window.removeEventListener('pointermove', onMove)
  window.clearTimeout(hideTimer)
  window.clearTimeout(moodTimer)
  if (frame) cancelAnimationFrame(frame)
})
</script>

<template>
  <div class="image-src hero-golem">
    <button
      ref="root"
      type="button"
      class="golem-btn"
      :class="mood && `is-${mood}`"
      aria-label="Pax, the golemkit golem. Press to hear what Pax says."
      @click="poke"
      v-html="svg"
    />
    <p class="golem-bubble" :class="{ shown }" role="status" aria-live="polite">{{ shown ? line : '' }}</p>
  </div>
</template>
