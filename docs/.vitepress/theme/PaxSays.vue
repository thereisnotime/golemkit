<script setup lang="ts">
// One line at the bottom of each docs page: something Pax says, or now and then a fun fact from the
// docs. Picked from the page path so the server render matches; pressing it shows the next one.
import { computed, ref, watch } from 'vue'
import { useRoute, withBase } from 'vitepress'
import { FACTS, QUIPS, pickFor } from './pax-lines'

type Item = { kind: 'quip' | 'fact', text: string }
// every third entry is a fact
const ITEMS: Item[] = []
QUIPS.forEach((q, i) => {
  ITEMS.push({ kind: 'quip', text: q })
  if (i % 2 === 1 && FACTS[i >> 1]) ITEMS.push({ kind: 'fact', text: FACTS[i >> 1]! })
})

const route = useRoute()
const offset = ref(0)
watch(() => route.path, () => { offset.value = 0 })
const item = computed(() => ITEMS[(pickFor(route.path, ITEMS.length) + offset.value) % ITEMS.length]!)
</script>

<template>
  <div class="pax-says">
    <img :src="withBase('/golem.svg')" alt="" width="22" height="19" />
    <button type="button" title="Another one" @click="offset++">
      <span class="pax-says-who">{{ item.kind === 'fact' ? 'Fun fact:' : 'Pax says:' }}</span>
      <span class="pax-says-text">{{ item.kind === 'fact' ? item.text : `"${item.text}"` }}</span>
    </button>
  </div>
</template>
