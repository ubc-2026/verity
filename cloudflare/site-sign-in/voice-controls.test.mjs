import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { mountVoiceControls, selectedMarket } from './voice-controls.mjs';

function mockPage({ protectedVoice = false, fetch, withDock = false, getUserMedia = async () => ({ getTracks: () => [] }) } = {}) {
  const button = { addEventListener(event, handler) { this.click = handler; } };
  const status = { textContent: '' };
  const time = {};
  const allowance = { hidden: true };
  const signIn = {};
  const mute = { addEventListener(event, handler) { this.click = handler; } };
  const browser = {
    navigator: { mediaDevices: { getUserMedia } }, fetch,
    addEventListener(event, handler) { this[event] = handler; }, setInterval() {}, clearInterval() {},
  };
  let dockOpen = false;
  let changeDock;
  const dock = withDock ? { classList: { contains: () => dockOpen } } : null;
  browser.MutationObserver = class {
    constructor(callback) { changeDock = callback; }
    observe() {}
  };
  const setDockOpen = open => {
    dockOpen = open;
    changeDock();
  };
  const elements = { button, '[role="status"]': status, '[data-voice-time]': time, '[data-voice-allowance]': allowance, '[data-voice-signin]': signIn, '[data-voice-mute]': mute };
  const controls = {
    dataset: { verityVoice: 'agent_demoFixture' },
    closest: () => dock,
    hasAttribute: () => protectedVoice,
    querySelector: selector => elements[selector],
  };
  const document = { querySelector: () => controls, createElement: tag => ({ tag }), defaultView: browser };
  return { button, status, browser, document, time, allowance, signIn, mute, setDockOpen };
}

test('voice starts in place only after a click and releases the call on exit', async () => {
  let loaded = 0;
  let ended = 0;
  let options;
  const { button, status, browser, document } = mockPage();
  mountVoiceControls(document, async () => {
    loaded++;
    return { Conversation: { async startSession(settings) {
      options = settings;
      return { endSession() { ended++; } };
    } } };
  });
  assert.equal(loaded, 0);
  await button.click();
  assert.equal(loaded, 1);
  assert.equal(options.agentId, 'agent_demoFixture');
  assert.equal(options.connectionType, 'webrtc');
  assert.equal(options.userId, undefined);
  assert.equal(button.textContent, 'End voice');
  options.onModeChange({ mode: 'speaking' });
  assert.equal(status.textContent, 'Agent is speaking…');
  browser.pagehide();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ended, 1);
  assert.equal(button.textContent, 'Start voice');
});

test('cancelling a pending load does not open a call', async () => {
  const sdk = Promise.withResolvers();
  const { button, status, document } = mockPage();
  mountVoiceControls(document, () => sdk.promise);
  const starting = button.click();
  await button.click();
  sdk.resolve({ Conversation: { startSession() { assert.fail('Cancelled start reached the provider'); } } });
  await starting;
  assert.equal(button.disabled, false);
  assert.equal(status.textContent, 'Voice start cancelled.');
});

test('shows a microphone denial without disabling text review', async () => {
  const { button, status, document } = mockPage();
  mountVoiceControls(document, async () => ({ Conversation: { async startSession() {
    throw new DOMException('Permission denied', 'NotAllowedError');
  } } }));
  await button.click();
  assert.equal(button.disabled, false);
  assert.match(status.textContent, /Microphone access was denied/);
});

test('denying the microphone leaves the visible balance and requests no call', async () => {
  const permission = Promise.withResolvers();
  const requests = [];
  const { button, document, status, allowance, setDockOpen } = mockPage({
    protectedVoice: true, withDock: true, fetch: async url => {
      requests.push(url);
      return Response.json({ mode: 'account', remaining: 2 });
    },
    getUserMedia: constraints => {
      assert.deepEqual(constraints, { audio: true });
      return permission.promise;
    },
  });
  mountVoiceControls(document, () => assert.fail('Denied microphone reached the SDK'));
  setDockOpen(true);
  await new Promise(resolve => setImmediate(resolve));
  const starting = button.click();
  assert.match(status.textContent, /Allow microphone access/);
  permission.reject(new DOMException('Permission denied', 'NotAllowedError'));
  await starting;
  assert.deepEqual(requests, ['/_verity/voice-allowance']);
  assert.equal(button.disabled, false);
  assert.equal(allowance.hidden, false);
  assert.equal(allowance.textContent, '2 calls remaining today');
  assert.equal(status.textContent, 'Microphone access was denied. No call was used.');
});

test('cancelling the permission prompt releases any late stream without requesting a call', async () => {
  const permission = Promise.withResolvers();
  let requests = 0;
  let stopped = 0;
  const { button, document, status } = mockPage({
    protectedVoice: true,
    fetch: async () => {
      requests++;
      return new Response(null, { status: 500 });
    },
    getUserMedia: () => permission.promise,
  });
  mountVoiceControls(document, () => assert.fail('Cancelled permission reached the SDK'));
  const starting = button.click();
  await button.click();
  permission.resolve({ getTracks: () => [{ stop() { stopped++; } }] });
  await starting;
  assert.equal(requests, 0);
  assert.equal(stopped, 1);
  assert.equal(status.textContent, 'Voice start cancelled.');
  assert.equal(button.disabled, false);
});

test('the exact browser bundle enables Start voice without opening a connection', async () => {
  const { button, document } = mockPage();
  button.disabled = true;
  const browserScript = await readFile(new URL('./.generated/voice-entry.txt', import.meta.url), 'utf8');
  runInNewContext(browserScript, { document });
  assert.equal(button.disabled, false);
  assert.equal(typeof button.click, 'function');
});

test('an expired sign-in is prompted and the voice SDK is never started', async () => {
  const { button, document, signIn } = mockPage({ protectedVoice: true, fetch: async () => new Response(null, { status: 401 }) });
  mountVoiceControls(document, () => assert.fail('Expired session reached the voice SDK'));
  await button.click();
  assert.equal(signIn.hidden, false);
});

test('a spent guest allowance offers sign-in without starting audio', async () => {
  const { button, document, signIn } = mockPage({
    protectedVoice: true, fetch: async () => Response.json({ error: 'guest_used' }, { status: 429 }),
  });
  mountVoiceControls(document, () => assert.fail('Guest with a spent allowance reached the voice SDK'));
  await button.click();
  assert.equal(signIn.hidden, false);
});

test('protected voice displays its allotted time and can mute the microphone', async () => {
  const permission = Promise.withResolvers();
  let requests = 0;
  let stopped = 0;
  const { button, document, time, allowance, mute } = mockPage({
    protectedVoice: true, getUserMedia: () => permission.promise, fetch: async () => {
      requests++;
      return Response.json({ signedUrl: 'wss://fixture/', callSeconds: 60, mode: 'guest', remaining: 0 });
    },
  });
  let muted;
  mountVoiceControls(document, async () => ({ Conversation: { async startSession(options) {
    assert.equal(stopped, 0);
    assert.equal(options.signedUrl, 'wss://fixture/');
    assert.equal(options.agentId, undefined);
    return { setMicMuted(value) { muted = value; } };
  } } }));
  const starting = button.click();
  assert.equal(requests, 0);
  permission.resolve({ getTracks: () => [{ stop() { stopped++; } }] });
  await starting;
  assert.equal(requests, 1);
  assert.equal(stopped, 1);
  assert.equal(time.textContent, '1:00 left');
  assert.equal(allowance.textContent, 'No guest calls available');
  mute.click();
  assert.equal(muted, true);
});

test('the signed-in panel shows its live balance before, during, and after calls', async () => {
  let remaining = 3;
  let started = 0;
  const { button, document, allowance, setDockOpen } = mockPage({
    protectedVoice: true, withDock: true, fetch: async url => {
      if (url === '/_verity/voice-allowance') return Response.json({ mode: 'account', remaining });
      assert.equal(url, '/_verity/voice-session');
      return Response.json({ signedUrl: 'wss://fixture/', callSeconds: 60, mode: 'account', remaining: --remaining });
    },
  });
  mountVoiceControls(document, async () => ({ Conversation: { async startSession() {
    started++;
    return { endSession() {} };
  } } }));
  setDockOpen(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(allowance.hidden, false);
  assert.equal(allowance.textContent, '3 calls remaining today');
  assert.equal(started, 0);
  for (const balance of ['2 calls remaining today', '1 call remaining today', '0 calls remaining today']) {
    await button.click();
    assert.equal(allowance.textContent, balance);
    await button.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(allowance.hidden, false);
    assert.equal(allowance.textContent, balance);
  }
  assert.equal(started, 3);
});

test('a slow status check cannot overwrite the balance after starting a call', async () => {
  const statusCheck = Promise.withResolvers();
  const { button, document, allowance, setDockOpen } = mockPage({
    protectedVoice: true, withDock: true, fetch: async url => url === '/_verity/voice-allowance'
      ? statusCheck.promise
      : Response.json({ signedUrl: 'wss://fixture/', callSeconds: 60, mode: 'account', remaining: 2 }),
  });
  mountVoiceControls(document, async () => ({ Conversation: { async startSession() { return {}; } } }));
  setDockOpen(true);
  await button.click();
  statusCheck.resolve(Response.json({ mode: 'account', remaining: 3 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(allowance.textContent, '2 calls remaining today');
});

test('the agent reads the open market itself through get_selected_market, and gets a clear answer when it cannot', async () => {
  const live = { source: 'live Gemini Exchange market', event_ticker: 'NBA1122LALBOS', title: 'Lakers vs Celtics', outcome: 'Lakers', best_bid: 0.64, best_ask: 0.68, rules_text: 'x'.repeat(9000) };
  let fitted = 0;
  const view = { marketContext: () => ({ ...live }), fitContext: ctx => { fitted++; return ctx; } };
  const answer = JSON.parse(selectedMarket(view));
  assert.equal(answer.available, true);
  assert.equal(answer.event_ticker, 'NBA1122LALBOS');
  assert.equal(answer.best_bid, 0.64);
  assert.ok(Date.parse(answer.read_at));
  assert.equal(answer.rules_text.length, 6001, 'long rules are trimmed for the voice model');
  assert.equal(fitted, 1);
  assert.deepEqual(JSON.parse(selectedMarket({})), { available: false, reason: 'No market is open on the page.' });
  assert.equal(JSON.parse(selectedMarket({ marketContext() { throw new Error('page not ready'); } })).available, false);

  const { button, document, browser } = mockPage({ protectedVoice: true, fetch: async () => Response.json({ signedUrl: 'wss://fixture/', callSeconds: 60, mode: 'account', remaining: 2 }) });
  browser.marketContext = view.marketContext;
  let tools;
  mountVoiceControls(document, async () => ({ Conversation: { async startSession(options) { tools = options.clientTools; return { endSession() {} }; } } }));
  await button.click();
  assert.deepEqual(Object.keys(tools), ['get_selected_market']);
  assert.equal(JSON.parse(tools.get_selected_market()).title, 'Lakers vs Celtics', 'the tool reads the page the call started on');
});
