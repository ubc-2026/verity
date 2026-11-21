/**
 * The voice agent's get_selected_market tool. It reads the market the visitor has open, using the same
 * marketContext() the text review sends (public prices, volume and rules only), so the agent never has to ask
 * the caller to describe it. Returns a JSON string; any failure becomes { available: false }.
 */
export function selectedMarket(view) {
  try {
    const raw = typeof view?.marketContext === 'function' ? view.marketContext() : null;
    if (!raw || typeof raw !== 'object') return JSON.stringify({ available: false, reason: 'No market is open on the page.' });
    const context = typeof view.fitContext === 'function' ? view.fitContext(raw) : raw;
    if (typeof context.rules_text === 'string' && context.rules_text.length > 6000) context.rules_text = context.rules_text.slice(0, 6000) + '…';
    return JSON.stringify({ available: true, read_at: new Date().toISOString(), ...context });
  } catch {
    return JSON.stringify({ available: false, reason: 'The page could not read the selected market.' });
  }
}

export function mountVoiceControls(document, loadSdk = () => import(new URL('/_verity/voice-sdk.js', document.defaultView.location.origin).href)) {
  const controls = document.querySelector('[data-verity-voice]');
  if (!controls) return;

  const button = controls.querySelector('button');
  const status = controls.querySelector('[role="status"]');
  const time = controls.querySelector('[data-voice-time]');
  const allowance = controls.querySelector('[data-voice-allowance]');
  const signIn = controls.querySelector('[data-voice-signin]');
  const mute = controls.querySelector('[data-voice-mute]');
  // Each call needs a fresh opt-in to send microphone audio to ElevenLabs.
  const consent = controls.querySelector('[data-voice-consent]');
  const dock = controls.closest('.ai-dock');
  const browser = document.defaultView;
  const protectedVoice = controls.hasAttribute('data-verity-voice-protected');
  let session;
  let microphoneCheck;
  let interval;
  let muted = false;
  let connecting = false;
  let ending = false;
  let run = 0;
  let allowanceVersion = 0;

  function updateButton(label, disabled = false) {
    button.textContent = label;
    button.disabled = disabled;
  }

  function releaseMicrophoneCheck() {
    for (const track of microphoneCheck?.getTracks() ?? []) track.stop();
    microphoneCheck = undefined;
  }

  function endVoice(message) {
    run++;
    releaseMicrophoneCheck();
    const previous = session;
    session = undefined;
    browser.clearInterval(interval);
    time.hidden = true;
    mute.hidden = true;
    status.textContent = message;
    if (!previous) {
      updateButton('Start voice', connecting || ending || !consent?.checked);
      return;
    }
    ending = true;
    if (consent) consent.checked = false;
    updateButton('Ending voice…', true);
    void Promise.resolve().then(() => previous.endSession()).catch(() => {}).finally(() => {
      ending = false;
      if (consent) consent.disabled = false;
      updateButton('Start voice', !consent?.checked);
    });
  }

  function showCallTimer(seconds) {
    const deadline = Date.now() + seconds * 1000;
    const render = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (!left) return endVoice('Time is up. The voice call ended.');
      const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      time.textContent = `${clock} left`;
    };
    render();
    time.hidden = false;
    interval = browser.setInterval(render, 1000);
  }

  function requestVoice(path) {
    return browser.fetch(path, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(18000),
    });
  }

  function showAllowance({ mode, remaining, error }) {
    if (!allowance) return;
    if (mode === 'account' && Number.isInteger(remaining) && remaining >= 0) {
      allowance.textContent = `${remaining} ${remaining === 1 ? 'call' : 'calls'} remaining today`;
    } else if (mode === 'guest' && (remaining === 0 || remaining === 1)) {
      allowance.textContent = remaining === 1 ? '1 guest call available' : 'No guest calls available';
      if (error === 'guest_used') signIn.hidden = false;
    } else {
      allowance.hidden = true;
      return;
    }
    allowance.hidden = false;
  }

  async function refreshAllowance() {
    if (!protectedVoice || !allowance || connecting || session || ending) return;
    const version = ++allowanceVersion;
    allowance.hidden = true;
    try {
      const response = await requestVoice('/_verity/voice-allowance');
      const balance = response.ok || response.status === 429 ? await response.json() : null;
      if (version !== allowanceVersion) return;
      signIn.hidden = response.status !== 401;
      if (balance) showAllowance(balance);
    } catch {
      // A status check is optional. The start request still enforces the allowance.
    }
  }

  async function toggleVoice() {
    if (session || connecting) {
      endVoice(connecting ? 'Voice start cancelled.' : 'Voice ended.');
      return;
    }
    if (ending) return;
    if (!consent?.checked) {
      status.textContent = 'Agree to send microphone audio before starting a voice call.';
      return;
    }
    if (!browser.navigator.mediaDevices?.getUserMedia) {
      status.textContent = 'Microphone access is unavailable in this browser. You can still use the text review.';
      return;
    }

    const current = ++run;
    connecting = true;
    consent.disabled = true;
    updateButton('Cancel voice start');
    let microphoneGranted = false;
    let sdkLoaded = false;
    try {
      let ticket;
      let sdk;
      if (protectedVoice) {
        status.textContent = 'Allow microphone access to start the call.';
        // Hold this local stream until the SDK opens its own input so one-time
        // microphone permission stays active through the handoff.
        microphoneCheck = await browser.navigator.mediaDevices.getUserMedia({ audio: true });
        if (current !== run) return;
        microphoneGranted = true;
        allowanceVersion++;
        signIn.hidden = true;
        if (allowance) allowance.hidden = true;
        status.textContent = 'Connecting…';
        // Load the SDK before asking for a ticket: the server charges the allowance when it issues one, so a
        // bundle that fails to load must fail here, before a guest's only call is spent.
        sdk = await loadSdk();
        sdkLoaded = true;
        if (current !== run) return;
        const response = await requestVoice('/_verity/voice-session');
        if (current !== run) return;
        if (response.status === 401) {
          status.textContent = 'Sign in with Google to use your daily voice allowance.';
          signIn.hidden = false;
          return;
        }
        if (response.status === 429) {
          const denial = await response.json();
          if (current !== run) return;
          showAllowance(denial);
          const { error, reset } = denial;
          if (error === 'guest_used') {
            status.textContent = 'The one-time guest call has been used for this browser or network. Sign in for three calls per day.';
            signIn.hidden = false;
            return;
          }
          status.textContent = error === 'rate_limit' ? 'Too many voice requests. Try again in a minute.'
            : `The voice allowance is used up. Resets ${new Date(reset).toLocaleString()}.`;
          return;
        }
        if (!response.ok) throw new Error('Voice provider unavailable');
        ticket = await response.json();
        if (current !== run) return;
        if (typeof ticket.signedUrl !== 'string' || !Number.isInteger(ticket.callSeconds) || ticket.callSeconds < 1 || ticket.callSeconds > 120) {
          throw new Error('Invalid voice ticket');
        }
        showAllowance(ticket);
      }
      status.textContent = protectedVoice ? 'Connecting…' : 'Connecting. Allow microphone access when asked.';
      const { Conversation } = sdk ?? await loadSdk();
      if (current !== run) return;
      const connected = await Conversation.startSession({
        ...(ticket ? { signedUrl: ticket.signedUrl, connectionType: 'websocket', libsampleratePath: '/_verity/voice-resampler.js' }
          : { agentId: controls.dataset.verityVoice, connectionType: 'webrtc' }),
        useWakeLock: false,
        clientTools: { get_selected_market: () => selectedMarket(browser) },
        onModeChange({ mode }) {
          if (current === run) status.textContent = mode === 'speaking' ? 'Agent is speaking…' : 'Listening…';
        },
        onDisconnect() {
          if (current === run) endVoice('Voice ended.');
        },
      });
      if (current !== run) {
        await connected.endSession();
        return;
      }
      session = connected;
      muted = false;
      mute.textContent = 'Mute microphone';
      mute.hidden = false;
      updateButton('End voice');
      status.textContent = 'Voice connected. Ask about public market rules.';
      showCallTimer(ticket?.callSeconds ?? 60);
    } catch (error) {
      if (current !== run) return;
      if (error?.name === 'NotAllowedError') {
        status.textContent = protectedVoice && !microphoneGranted
          ? 'Microphone access was denied. No call was used.'
          : 'Microphone access was denied. Allow it in your browser and try again.';
      } else if (protectedVoice && microphoneGranted && !sdkLoaded) {
        status.textContent = 'Voice could not load. No call was used. Check your connection and try again.';
      } else {
        status.textContent = 'Voice is unavailable. The demo may be busy or at its limit. You can still use the text review.';
      }
    } finally {
      releaseMicrophoneCheck();
      connecting = false;
      if (!session) {
        consent.disabled = false;
        updateButton('Start voice', !consent.checked);
      }
      if (current !== run && dock?.classList.contains('open')) void refreshAllowance();
    }
  }

  button.addEventListener('click', toggleVoice);
  consent?.addEventListener('change', () => {
    if (!session && !connecting && !ending) updateButton('Start voice', !consent.checked);
  });
  mute.addEventListener('click', () => {
    if (!session) return;
    muted = !muted;
    session.setMicMuted(muted);
    mute.textContent = muted ? 'Unmute microphone' : 'Mute microphone';
  });
  browser.addEventListener('pagehide', () => endVoice('Voice ended.'));
  if (dock) {
    let open = dock.classList.contains('open');
    const observer = new browser.MutationObserver(() => {
      const isOpen = dock.classList.contains('open');
      if (isOpen === open) return;
      open = isOpen;
      if (open) void refreshAllowance();
      else if (session || connecting) endVoice('Voice ended.');
    });
    observer.observe(dock, { attributes: true, attributeFilter: ['class'] });
    if (open) void refreshAllowance();
  }
  button.disabled = !consent?.checked;
}
