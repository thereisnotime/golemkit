<script setup lang="ts">
// The 404 page: the golem holds up a lantern and looks around for the missing page.
import { withBase } from 'vitepress'
import { golemSvg } from './golem-svg'

const D = '#3f4650'
const r = (x: number, y: number, w: number, h: number, fill: string) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`
// a stone arm out to the right and a plain lantern hanging from it
const lantern =
  r(27, 15, 7, 2, '#949ea9') + r(27, 17, 7, 1, '#76808b') + r(33, 14, 2, 4, '#a9b2bc') +
  '<g class="g-lantern">' +
  r(33.5, 18, 1, 2, D) + r(31.5, 20, 5, 1, D) +
  '<circle class="g-light" cx="34" cy="23" r="5" fill="#fde047" filter="url(#lost-glow)"/>' +
  r(31.5, 21, 5, 5, D) + r(32.5, 22, 3, 3, '#facc15') + r(33.5, 22, 1, 2, '#fef9c3') +
  r(31, 26, 6, 1, D) +
  '</g>'
const svg = golemSvg('lost', { extra: lantern, width: 40 })
</script>

<template>
  <div class="golem-404">
    <div class="golem-404-art" v-html="svg" />
    <p class="golem-404-code">404</p>
    <h1 class="golem-404-title">this chunk failed to load</h1>
    <p class="golem-404-text">Pax walked out here with a lantern and found only void. The page may have moved, or it was never generated.</p>
    <a class="golem-404-home" :href="withBase('/')">go_home</a>
  </div>
</template>
