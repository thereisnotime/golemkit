// Text helpers for journal entries.

const SECRET_CMD = /^\/(login|log|l|register|reg|changepassword|changepass|cp)\b.*/i
export const cut = (s: unknown, n: number) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t }

/** Slash commands that carry passwords keep only the command name. */
export function maskChat (msg: string): string {
  return SECRET_CMD.test(msg) ? msg.replace(SECRET_CMD, (_m, c) => `/${c} ***`) : msg
}

/** Text of a kick/disconnect reason (string or chat component JSON). */
export function reasonText (r: unknown): string {
  if (typeof r === 'string') {
    try { return reasonText(JSON.parse(r)) } catch { return r }
  }
  if (r && typeof r === 'object') {
    const o = r as Record<string, any>
    const own = typeof o.text === 'string' ? o.text : typeof o.translate === 'string' ? o.translate : ''
    const extra = Array.isArray(o.extra) ? o.extra.map(reasonText).join('') : ''
    const value = o.value !== undefined && typeof o.value !== 'object' ? String(o.value) : ''
    return (own + extra || value || JSON.stringify(r)).trim()
  }
  return String(r ?? '')
}
