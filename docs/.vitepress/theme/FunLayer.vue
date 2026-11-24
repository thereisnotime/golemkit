<script setup lang="ts">
// Page-wide bits: the reading-progress "XP bar" at the top of docs pages and the toast stack that
// fun.ts writes to. The bar is decorative (aria-hidden) and only moves with the scroll position.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useData, useRoute } from 'vitepress'

const { frontmatter, page } = useData()
const route = useRoute()
const isDoc = computed(() => frontmatter.value.layout !== 'home' && !page.value.isNotFound)

const fill = ref<HTMLElement>()
const full = ref(false)
let frame = 0
let wasBelow = false

function measure (): void {
  frame = 0
  const max = document.documentElement.scrollHeight - window.innerHeight
  const p = max > 40 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0
  if (fill.value) fill.value.style.transform = `scaleX(${p})`
  if (p < 0.9) wasBelow = true
  // a level-up flash once per page, only for pages long enough to scroll through
  if (p >= 0.995 && wasBelow && !full.value && max > window.innerHeight * 0.8) {
    full.value = true
    toast('level up: page read')
  }
}
const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }

type Toast = { id: number, text: string }
const toasts = ref<Toast[]>([])
let ids = 0
function toast (text: string): void {
  const t = { id: ++ids, text }
  toasts.value = [...toasts.value.slice(-2), t]
  // compare ids: the array holds Vue proxies, so `x !== t` never matched and toasts piled up
  window.setTimeout(() => { toasts.value = toasts.value.filter(x => x.id !== t.id) }, 2800)
}
const onToast = (e: Event) => toast(String((e as CustomEvent).detail))

watch(() => route.path, () => {
  full.value = false
  wasBelow = false
  nextTick(schedule)
})
onMounted(() => {
  window.addEventListener('scroll', schedule, { passive: true })
  window.addEventListener('resize', schedule, { passive: true })
  window.addEventListener('golem:toast', onToast)
  schedule()
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', schedule)
  window.removeEventListener('resize', schedule)
  window.removeEventListener('golem:toast', onToast)
  if (frame) cancelAnimationFrame(frame)
})
</script>

<template>
  <div v-if="isDoc" class="xp-bar" :class="{ full }" aria-hidden="true"><div ref="fill" class="xp-fill" /></div>
  <div class="fun-toasts" role="status" aria-live="polite">
    <p v-for="t in toasts" :key="t.id" class="fun-toast">{{ t.text }}</p>
  </div>
</template>
