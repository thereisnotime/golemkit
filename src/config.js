// Settings come from the environment (.env is loaded by `npm start`, see .env.example).
const env = process.env

const list = (v) => (v || '').split(',').map(s => s.trim()).filter(Boolean)
const bool = (v, d) => v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v)

export const config = {
  host: env.MC_HOST || 'mc.example.com',
  port: Number(env.MC_PORT || 25565),
  username: env.MC_USERNAME || 'McBuddy',
  // 'offline' for offline-mode servers, 'microsoft' for a real account (device-code login, token cached in .auth/)
  auth: env.MC_AUTH || 'offline',
  version: env.MC_VERSION || '1.21.1',
  // Players allowed to give commands. Empty = everyone.
  owners: list(env.MC_OWNERS).map(s => s.toLowerCase()),
  prefix: env.MC_PREFIX || '!',
  canDig: bool(env.MC_CAN_DIG, false),
  reconnectDelayMs: Number(env.MC_RECONNECT_DELAY_MS || 10000),
  debug: bool(env.MC_DEBUG, false)
}
