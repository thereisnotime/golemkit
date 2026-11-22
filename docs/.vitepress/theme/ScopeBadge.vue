<script setup lang="ts">
// Scope badge at the top of a docs page, from frontmatter `scope` (core | minecraft | neoforge |
// mixed) and, for mixed pages, `scopeNote`. Links to the page that explains the scopes.
import { computed } from 'vue'
import { useData, withBase } from 'vitepress'

const SCOPES: Record<string, { label: string, tip: string }> = {
  core: { label: 'Game-agnostic', tip: 'Nothing here depends on Minecraft: it belongs to the core that every game adapter shares.' },
  minecraft: { label: 'Minecraft-specific', tip: 'Built on Mineflayer and Minecraft rules (blocks, items, mobs). It moves to the Minecraft Java adapter in the split.' },
  neoforge: { label: 'NeoForge-specific', tip: 'Only matters on NeoForge servers: the mod handshake and wire formats in src/core/neoforge/.' },
  mixed: { label: 'Mixed', tip: 'A game-agnostic mechanism with Minecraft-specific parts.' }
}

const { frontmatter } = useData()
const scope = computed(() => {
  const s = SCOPES[String(frontmatter.value.scope ?? '')]
  return s ? { key: String(frontmatter.value.scope), ...s } : null
})
const note = computed(() => frontmatter.value.scopeNote ? String(frontmatter.value.scopeNote) : '')
</script>

<template>
  <div v-if="scope" class="scope-line">
    <a class="scope-badge" :class="scope.key" :href="withBase('/concepts/scope')" :title="scope.tip">{{ scope.label }}</a>
    <span v-if="note" class="scope-note">{{ note }}</span>
  </div>
</template>
