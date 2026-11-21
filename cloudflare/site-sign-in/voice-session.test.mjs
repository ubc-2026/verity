import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { VoiceBudget } from './voice-budget.mjs';
import { issueVoiceSession } from './voice-session.mjs';

const origin = 'https://verityresearch.us';
const agent = 'agent_0123456789abcdef';
const account = 'a0123456-f123-4567-8123-912345678900';
const differentAccount = 'a0123456-f123-4567-8123-912345678901';

function budget(database = new DatabaseSync(':memory:')) {
  return new VoiceBudget({ storage: {
    sql: { exec(statement, ...args) {
      const rows = database.prepare(statement).all(...args.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value));
      return { toArray: () => rows, one: () => rows[0] };
    } },
    transactionSync(operation) {
      database.exec('BEGIN');
      try {
        const result = operation();
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } });
}

function reserve(storage, user, browser = '', ip) {
  return storage.fetch(new Request('https://voice-budget.internal/', { method: 'POST', body: JSON.stringify({ account: user, browser, ip }) }));
}

test('competing tabs share a browser allowance across verified accounts', async () => {
  const storage = budget();
  const first = await (await reserve(storage, account)).json();
  assert.equal((await reserve(storage, account, first.browser)).status, 200);
  const results = await Promise.all([reserve(storage, account, first.browser), reserve(storage, differentAccount, first.browser)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 429]);
});

test('the account allowance applies across fresh browser cookies', async () => {
  const storage = budget();
  assert.equal((await reserve(storage, account)).status, 200);
  assert.equal((await reserve(storage, account)).status, 200);
  assert.equal((await reserve(storage, account)).status, 200);
  assert.equal((await reserve(storage, account)).status, 429);
});

test('guest use survives a storage restart and is bound independently to IP and browser', async (testContext) => {
  const directory = mkdtempSync(join(tmpdir(), 'verity-voice-db-'));
  const path = join(directory, 'budget.sqlite');
  let database = new DatabaseSync(path);
  testContext.after(() => {
    database.close();
    unlinkSync(path);
    rmdirSync(directory);
  });
  let storage = budget(database);
  let today = Date.UTC(2026, 9, 1);
  testContext.mock.method(Date, 'now', () => today);
  const attempts = await Promise.all([reserve(storage, null, '', '192.0.2.1'), reserve(storage, null, '', '192.0.2.1')]);
  assert.deepEqual(attempts.map(result => result.status).sort(), [200, 429]);
  const { browser, remaining } = await attempts.find(result => result.ok).json();
  assert.equal(remaining, 0);
  database.close();
  database = new DatabaseSync(path);
  storage = budget(database);
  today = Date.UTC(2027, 0, 1);
  for (const [cookie, ip] of [['', '192.0.2.1'], [browser, '192.0.2.2']]) {
    const denied = await reserve(storage, null, cookie, ip);
    assert.equal(denied.status, 429);
    assert.deepEqual(await denied.json(), { error: 'guest_used' });
  }
  assert.equal((await reserve(storage, null, '', '192.0.2.2')).status, 200);
});

test('the demo reserves no more than 100 starts in its rolling window', async (testContext) => {
  const storage = budget();
  let today = Date.UTC(2026, 9, 1);
  testContext.mock.method(Date, 'now', () => today);
  for (let day = 0; day < 5; day++) {
    today = Date.UTC(2026, 9, day + 1);
    assert.equal((await reserve(storage, null, '', `192.0.2.${day + 1}`)).status, 200);
    for (let index = 0; index < 19; index++) {
      const person = account.slice(0, -3) + String(index).padStart(3, '0');
      assert.equal((await reserve(storage, person)).status, 200);
    }
    assert.equal((await reserve(storage, differentAccount)).status, 429);
  }
  today = Date.UTC(2026, 9, 6);
  const denied = await reserve(storage, account);
  assert.equal(denied.status, 429);
  assert.equal((await denied.json()).error, 'rolling_limit');
  today = Date.UTC(2026, 10, 1);
  assert.equal((await reserve(storage, account)).status, 200);
});

function request(cookie = '', requestOrigin = origin, path = 'voice-session') {
  return new Request(`${origin}/_verity/${path}`, {
    method: 'POST', headers: { origin: requestOrigin, cookie, 'cf-connecting-ip': '192.0.2.1' },
  });
}

test('the Worker checks quota before signing and consumes it only after successful signing', async (testContext) => {
  const storage = budget();
  const env = {
    VERITY_ELEVENLABS_AGENT_ID: agent, ELEVENLABS_API_KEY: 'fixture',
    VOICE_IP_LIMIT: { limit: async () => ({ success: true }) },
    VERITY_VOICE_ACCOUNT: { fetch: async (url, options) => options.headers.cookie === '__Host-verity-session=valid'
      ? Response.json({ accountId: account }) : new Response(null, { status: 401 }) },
    VOICE_BUDGET: { getByName: () => ({ fetch: (url, init) => storage.fetch(new Request(url, init)) }) },
  };
  const noProvider = () => assert.fail('Refused request reached ElevenLabs');
  assert.equal((await issueVoiceSession(request('__Host-verity-session=expired'), env, noProvider)).status, 401);
  assert.equal((await issueVoiceSession(request('__Host-verity-session=valid', 'https://other.example'), env, noProvider)).status, 403);
  const status = (cookie = '', requestOrigin = origin) => issueVoiceSession(request(cookie, requestOrigin, 'voice-allowance'), env, noProvider);
  assert.equal((await status('__Host-verity-session=expired')).status, 401);
  assert.equal((await status('__Host-verity-session=valid', 'https://other.example')).status, 403);
  const guestStatus = await status();
  assert.equal(guestStatus.headers.get('set-cookie'), null);
  assert.equal(guestStatus.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await guestStatus.json(), { mode: 'guest', remaining: 1 });
  const send = async (url, options) => {
    assert.equal(url.searchParams.get('agent_id'), agent);
    assert.equal(url.searchParams.get('include_conversation_id'), 'true');
    assert.equal(options.headers['xi-api-key'], 'fixture');
    assert.equal(options.headers.cookie, undefined);
    return Response.json({ signed_url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agent}&conversation_signature=fixture` });
  };
  testContext.mock.method(console, 'warn', () => {});
  assert.equal((await issueVoiceSession(request(), env, async () => new Response(null, { status: 401 }))).status, 503);
  const guest = await issueVoiceSession(request(), env, send);
  assert.equal(guest.status, 200);
  assert.match(guest.headers.get('set-cookie'), /^__Host-verity-voice-guest=.*Secure; HttpOnly; SameSite=Strict/);
  assert.deepEqual(await guest.json(), { signedUrl: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agent}&conversation_signature=fixture`, mode: 'guest', remaining: 0, callSeconds: 60 });
  assert.equal((await issueVoiceSession(request(), env, noProvider)).status, 429);
  assert.deepEqual(await (await status()).json(), { error: 'guest_used', mode: 'guest', remaining: 0 });
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(await (await status('__Host-verity-session=valid')).json(), { mode: 'account', remaining: 3 - index });
    const admitted = await issueVoiceSession(request('__Host-verity-session=valid'), env, send);
    assert.equal(admitted.status, 200);
    assert.match(admitted.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Strict/);
    const { mode, remaining } = await admitted.json();
    assert.equal(mode, 'account');
    assert.equal(remaining, 2 - index);
  }
  assert.equal((await issueVoiceSession(request('__Host-verity-session=valid'), env, noProvider)).status, 429);
  const exhausted = await status('__Host-verity-session=valid');
  assert.equal(exhausted.status, 429);
  const { mode, remaining, error } = await exhausted.json();
  assert.deepEqual({ mode, remaining, error }, { mode: 'account', remaining: 0, error: 'daily_limit' });
});
