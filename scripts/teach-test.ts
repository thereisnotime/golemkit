// Live test for the self-improver: joins as an owner tester, walks over to the bot, teaches it
// with a few chat instructions and then checks it keeps doing what it learned. Every line of
// chat it sees is printed. Steps are separated by ";". Besides chat lines:
//   "/w <player> <text>"     whisper
//   "wait:<ms>"              pause
//   "until:<regex>"          wait for a chat line matching it (UNTIL_MS, default 4 min)
//   "come"                   walk over to the bot
//   "mark:<name>:<dx>:<dz>"  make the bot remember a place relative to its own position
//   "markself:<name>"        make the bot remember the spot where the tester stands
//
//   node src/cli.ts run apprentice --owners ApprenticeTester &
//   node scripts/teach-test.ts "come;/w Apprentice learn: ...;until:learned it|couldn't;hello;wait:5000"
import { Agent, defineBot, serverFromEnv } from '../src/core/index.ts'
import { movement } from '../src/skills/index.ts'

const target = process.env.BOT || 'Apprentice'
const steps = (process.argv[2] || '').split(';').map(s => s.trim()).filter(Boolean)
const tester = new Agent(defineBot({ name: 'tester', skills: [movement()], brains: [] }), serverFromEnv(), {
  username: process.env.TESTER || 'ApprenticeTester',
  dataDir: 'data/tester'
})
const seen: string[] = []
const stamp = () => new Date().toISOString().slice(11, 19)
tester.on('chat', m => { const l = `${m.whisper ? '(whisper) ' : ''}<${m.from}> ${m.message}`; seen.push(l); console.log(`${stamp()} chat> ${l}`) })
tester.on('serverMessage', m => console.log(`${stamp()} server> ${m}`))

async function until (re: RegExp, ms: number): Promise<boolean> {
  const start = seen.length
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (seen.slice(start).some(l => re.test(l))) return true
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

tester.once('session', async (bot) => {
  await new Promise(r => setTimeout(r, 4000))
  console.log(`${stamp()} time of day ${bot.time.timeOfDay}`)
  for (const s of steps) {
    if (s.startsWith('wait:')) { await new Promise(r => setTimeout(r, Number(s.slice(5)))); continue }
    if (s.startsWith('until:')) {
      const okk = await until(new RegExp(s.slice(6), 'i'), Number(process.env.UNTIL_MS || 240_000))
      console.log(`${stamp()} until ${s.slice(6)}: ${okk ? 'seen' : 'TIMEOUT'}`)
      continue
    }
    if (s === 'come') {
      const r = await tester.act('goto_player', { player: target })
      console.log(`${stamp()} come: ${r.message}`)
      continue
    }
    if (s.startsWith('markself:')) {
      const p = bot.entity.position
      const line = `!remember_place ${s.slice(9)} ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`
      console.log(`${stamp()} send> ${line}`)
      tester.say(line)
      await new Promise(r => setTimeout(r, 2500))
      continue
    }
    if (s.startsWith('mark:')) {
      const [, name, dx, dz] = s.split(':')
      const e = bot.players[target]?.entity
      if (!e) { console.log(`${stamp()} mark: ${target} not visible`); continue }
      const p = e.position
      const line = `!remember_place ${name} ${Math.floor(p.x) + Number(dx)} ${Math.floor(p.y)} ${Math.floor(p.z) + Number(dz)}`
      console.log(`${stamp()} send> ${line}`)
      tester.say(line)
      await new Promise(r => setTimeout(r, 2500))
      continue
    }
    if (s.startsWith('/w ')) {
      const [, to, ...rest] = s.split(' ')
      console.log(`${stamp()} whisper> ${to}: ${rest.join(' ')}`)
      tester.whisper(to!, rest.join(' '))
    } else {
      console.log(`${stamp()} send> ${s}`)
      tester.say(s)
    }
    await new Promise(r => setTimeout(r, 2500))
  }
  await tester.stop()
  process.exit(0)
})
setTimeout(() => { console.log('overall timeout'); process.exit(2) }, Number(process.env.TOTAL_MS || 900_000))
void tester.start()
