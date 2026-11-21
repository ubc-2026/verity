export const voiceLimits = Object.freeze({ seconds: 60, personal: 3, daily: 20, rolling: 100, rollingDays: 31 });

const dayMs = 86_400_000;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const toHex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');

export class VoiceBudget {
  constructor(ctx) {
    this.storage = ctx.storage;
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY, seed BLOB NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS usage (day INTEGER NOT NULL, scope TEXT NOT NULL, starts INTEGER NOT NULL, PRIMARY KEY (day, scope))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS guest_uses (scope TEXT PRIMARY KEY)');
    this.sql.exec('INSERT OR IGNORE INTO identity (id, seed) VALUES (1, ?)', crypto.getRandomValues(new Uint8Array(32)).buffer);
    const { seed } = this.sql.exec('SELECT seed FROM identity WHERE id = 1').one();
    this.key = crypto.subtle.importKey('raw', seed, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  }

  async fetch(request) {
    if (request.method !== 'POST' && request.method !== 'PUT') return new Response(null, { status: 405 });
    const consume = request.method === 'POST';
    const { account, browser, ip } = await request.json();
    const guest = account === null;
    if (guest ? typeof ip !== 'string' || !/^[0-9a-f:.]{3,45}$/i.test(ip) : typeof account !== 'string' || !uuid.test(account)) {
      return new Response(null, { status: 400 });
    }

    const key = await this.key;
    const device = typeof browser === 'string' && browser.length <= 101 ? browser.split('.') : [];
    const trusted = device.length === 2 && uuid.test(device[0]) && /^[0-9a-f]{64}$/.test(device[1]) && await crypto.subtle.verify(
      'HMAC', key, Uint8Array.from(device[1].match(/../g), pair => parseInt(pair, 16)), encoder.encode(`cookie:${device[0]}`),
    );
    const deviceId = trusted ? device[0] : crypto.randomUUID();
    const hash = async value => toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
    const [accountScope, deviceScope, signature] = await Promise.all([
      hash(guest ? `guest-ip:${ip.toLowerCase()}` : `account:${account.toLowerCase()}`),
      hash(guest ? `guest-browser:${deviceId}` : `browser:${deviceId}`),
      hash(`cookie:${deviceId}`),
    ]);

    const now = Date.now();
    const day = Math.floor(now / dayMs);
    const oldest = day - voiceLimits.rollingDays + 1;
    const reset = (day + 1) * dayMs;
    const scopes = [['all', voiceLimits.daily]];
    if (!guest) scopes.push([accountScope, voiceLimits.personal], [deviceScope, voiceLimits.personal]);
    const result = this.storage.transactionSync(() => {
      if (guest && this.sql.exec('SELECT 1 FROM guest_uses WHERE scope IN (?, ?) LIMIT 1', accountScope, deviceScope).toArray().length) {
        return { error: 'guest_used' };
      }
      const counts = scopes.map(([scope]) => this.sql.exec('SELECT starts FROM usage WHERE day = ? AND scope = ?', day, scope).toArray()[0]?.starts ?? 0);
      if (counts.some((count, index) => count >= scopes[index][1])) return { error: 'daily_limit', reset };
      const rolling = this.sql.exec("SELECT COALESCE(SUM(starts), 0) AS total, MIN(day) AS first FROM usage WHERE scope = 'all' AND day >= ?", oldest).one();
      if (rolling.total >= voiceLimits.rolling) return { error: 'rolling_limit', reset: (rolling.first + voiceLimits.rollingDays) * dayMs };
      if (consume) {
        this.sql.exec("DELETE FROM usage WHERE day < ? OR (scope <> 'all' AND day < ?)", oldest, day);
        if (guest) this.sql.exec('INSERT INTO guest_uses (scope) VALUES (?), (?)', accountScope, deviceScope);
        for (const [scope] of scopes) {
          this.sql.exec('INSERT INTO usage (day, scope, starts) VALUES (?, ?, 1) ON CONFLICT(day, scope) DO UPDATE SET starts = starts + 1', day, scope);
        }
      }
      const remaining = Math.min(...scopes.map(([, limit], index) => limit - counts[index]), voiceLimits.rolling - rolling.total) - 1;
      return { remaining: guest ? 0 : remaining };
    });
    return Response.json(result.error ? result : { ...result, browser: `${deviceId}.${signature}` }, { status: result.error ? 429 : 200 });
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
