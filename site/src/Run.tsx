import {useCallback, useEffect, useMemo, useState} from 'react';
import preview from './fixture-preview.json';
import ResearchHistory from './ResearchHistory';

/* The run page: one Gemini Exchange market, read, scored, checked against free sources, then bought or not.
   Talks to the Verity app API (npm run app). Without it, shows the recorded fixture preview, read-only. */

type Json = any;
type Mode = 'loading' | 'connected' | 'preview';

const EXPLORER = 'https://explorer.testnet.arc.io/tx/';
const TOKEN_KEY = 'verity-operator-token';

async function api(path: string, init: {method?: string; body?: unknown; token?: string} = {}) {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? {'content-type': 'application/json'} : {}),
      ...(init.token ? {authorization: `Bearer ${init.token}`} : {}),
    },
    ...(init.body !== undefined ? {body: JSON.stringify(init.body)} : {}),
  });
  const json = await res.json().catch(() => ({}));
  return {status: res.status, json};
}

const short = (v?: string | null) => (v ? `${v.slice(0, 10)}…${v.slice(-6)}` : '—');
const pct = (v?: string | null) => (v == null ? '—' : `${Math.round(Number(v) * 100)}¢`);

const QUOTE_TONE: Record<string, string> = {two_sided: 'tone-good', one_sided_bid: 'tone-warn', one_sided_ask: 'tone-warn', missing: 'tone-bad', crossed: 'tone-bad', stale: 'tone-warn', closed: 'muted'};
const QUOTE_LABEL: Record<string, string> = {two_sided: 'Two-sided', one_sided_bid: 'Bid only', one_sided_ask: 'Ask only', missing: 'No quote', crossed: 'Crossed', stale: 'Stale', closed: 'Closed'};

function QuoteTag({q}: {q: Json}) {
  return <span className={`tag ${QUOTE_TONE[q.state] ?? ''}`}>{QUOTE_LABEL[q.state] ?? q.state}</span>;
}

function Pips({n}: {n: number | null}) {
  return (
    <span className="pips" aria-label={n == null ? 'not scored' : `${n} of 3`}>
      {[1, 2, 3].map((i) => <span key={i} className={n != null && i <= n ? 'on' : ''} />)}
    </span>
  );
}

function tone(state: string): string {
  if (['verified', 'confirmed', 'Reconciled', 'allowed', 'approved', 'revised', 'issued', 'signed', 'settled'].includes(state)) return 'tone-good';
  if (['rejected', 'refused', 'Mismatch', 'expired', 'evidence_rejected'].includes(state)) return 'tone-bad';
  if (['received_unverified', 'submitted_unconfirmed', 'Paid, delivery missing', 'Delivered, payment unconfirmed', 'needs_owner_approval', 'requested', 'awaiting_approval', 'ready'].includes(state)) return 'tone-warn';
  return 'muted';
}
const words = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function StateCell({title, state, children}: {title: string; state: string; children?: React.ReactNode}) {
  return (
    <div className="state-cell">
      <p className="label">{title}</p>
      <p><span className={`tag ${tone(state)}`}>{words(state)}</span></p>
      {children}
    </div>
  );
}

/* ---------- market picker ---------- */

function FixtureMarkets({markets, selected, onSelect}: {markets: Json[]; selected: string; onSelect: (id: string) => void}) {
  return (
    <div className="table-scroll">
      <table className="ledger-table">
        <thead>
          <tr><th>Market</th><th>Bid / ask</th><th>Implied</th><th>Quote</th><th>Snapshot</th></tr>
        </thead>
        <tbody>
          {markets.map((m) => (
            <tr key={m.contractId} className={m.contractId === selected ? 'is-on' : ''}>
              <td>
                <label className="pick">
                  <input type="radio" name="market" checked={m.contractId === selected} onChange={() => onSelect(m.contractId)} />
                  <span>{m.question}<span className="label">{m.contractId}</span></span>
                </label>
              </td>
              <td className="mono">{m.quote.bestBid ?? '—'} / {m.quote.bestAsk ?? '—'}</td>
              <td className="mono">{pct(m.quote.impliedProbability)}</td>
              <td><QuoteTag q={m.quote} /><div className="label">{m.quote.note}</div></td>
              <td className="mono">{m.source.snapshotTimeUtc ?? `${m.source.snapshotDate}, time not recorded`}<div className="label">{m.source.label}</div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LiveMarkets() {
  const [snap, setSnap] = useState<Json | null>(null);
  const [message, setMessage] = useState('Reading Gemini Exchange…');
  const load = useCallback(async () => {
    setMessage('Reading Gemini Exchange…');
    try {
      const {status, json} = await api('/markets/live?limit=12');
      if (status !== 200) throw new Error(json.error ?? String(status));
      setSnap(json);
      setMessage(json.note);
    } catch {
      setMessage('The app server did not answer, so no live reading is shown.');
    }
  }, []);
  useEffect(() => void load(), [load]);
  return (
    <>
      <p className="label ledger-note">
        <span className={`tag ${snap?.state === 'ok' ? 'tone-good' : snap ? 'tone-warn' : 'muted'}`}>{snap ? `LIVE read-only · ${snap.state}` : 'LIVE read-only'}</span>{' '}
        {snap?.fetchedAtUtc ? `Read ${snap.fetchedAtUtc}. ` : ''}{message} Live markets are shown, not analyzed or bought from, in this build.{' '}
        <button className="btn btn-line btn-sm" type="button" onClick={() => void load()}>Refresh</button>
      </p>
      {snap?.events?.map((e: Json) => (
        <details className="live-event" key={e.ticker}>
          <summary>
            <strong>{e.title}</strong> <span className="label">{e.ticker} · expires {e.expiryUtc ?? '—'} · {e.contracts.length} contracts</span>
          </summary>
          <div className="table-scroll">
            <table className="ledger-table">
              <thead><tr><th>Contract</th><th>Bid / ask</th><th>Implied</th><th>Quote</th><th>Read at</th></tr></thead>
              <tbody>
                {e.contracts.map((c: Json) => (
                  <tr key={`${e.ticker}-${c.ticker ?? c.label}`}>
                    <td>{c.label}<div className="label">{c.instrumentSymbol ?? '—'}</div></td>
                    <td className="mono">{c.quote.bestBid ?? '—'} / {c.quote.bestAsk ?? '—'}</td>
                    <td className="mono">{pct(c.quote.impliedProbability)}</td>
                    <td><QuoteTag q={c.quote} />{c.quote.lastTradePrice && c.quote.state !== 'two_sided' ? <div className="label">Last trade {c.quote.lastTradePrice}</div> : null}</td>
                    <td className="mono">{c.quote.observedAtUtc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </>
  );
}

/* ---------- the reading of one run ---------- */

function Reading({view}: {view: Json}) {
  const m = view.market;
  return (
    <>
      <div className="run-strip">
        <div className="state-cell">
          <p className="label">Market-implied price · {m.source.snapshotTimeUtc ?? `snapshot ${m.source.snapshotDate}`}</p>
          <p className="big">{pct(m.quote.impliedProbability)} <QuoteTag q={m.quote} /></p>
          <p className="label">Bid {m.quote.bestBid ?? '—'}, ask {m.quote.bestAsk ?? '—'}, volume ${m.volumeUsd ?? '—'} ({m.volumeBasis ?? '—'}). {m.quote.note}</p>
        </div>
        <div className="state-cell">
          <p className="label">Settlement-risk rating, separate from the price</p>
          <p className="big">{view.rating.total ?? '—'}<small>/12</small> <span className={`tag ${view.rating.final === 'High' ? 'tone-bad' : view.rating.final === 'Medium' ? 'tone-warn' : 'tone-good'}`}>{view.rating.final ?? 'Incomplete'}</span></p>
          <p className="label">{view.rating.summary}</p>
        </div>
        <div className="state-cell">
          <p className="label">Data</p>
          <p><span className="tag tone-warn">{view.label}</span></p>
          <p className="label">{m.source.label}. Snapshot {m.snapshotHash.slice(0, 22)}…</p>
        </div>
      </div>

      <div className="hallmarks run-hallmarks">
        {view.rating.scores.map((s: Json) => (
          <div className="hallmark" key={s.name}>
            <div className="hallmark-top"><span className="label">{words(s.name)}</span><Pips n={s.score} /></div>
            <p>{s.score == null ? s.nullReason : s.rationale}</p>
          </div>
        ))}
      </div>

      <div className="run-two">
        <div>
          <h3>The rule</h3>
          <p className="lead">{view.rule.settlementSource ?? 'Settlement source not stated.'}</p>
          {view.rule.citations.map((c: Json) => (
            <blockquote className="rule-quote" key={c.id}>
              <p className="mono">{c.id} · {c.field_or_rule}</p>
              <p>“{c.quote}”</p>
            </blockquote>
          ))}
          {view.rule.termsUrl ? <p className="label"><a href={view.rule.termsUrl} rel="noreferrer" target="_blank">Contract terms</a>{view.rule.termsNote ? ` · ${view.rule.termsNote}` : ''}</p> : null}
        </div>
        <div>
          <h3>Open evidence gaps</h3>
          {view.gaps.filter((g: Json) => g.open).length === 0 ? <p className="lead">None open.</p> : null}
          {view.gaps.map((g: Json) => (
            <div className={`gap-card ${g.open ? 'is-open' : ''}`} key={g.id}>
              <p className="label">{g.id} · {g.open ? 'open, affects settlement' : g.affects === 'outcome_probability' ? 'forecast, not bought' : 'not material'}</p>
              <p>{g.question}</p>
            </div>
          ))}
        </div>
      </div>

      <div className={`verdict-card ${view.decision.action === 'buy' ? 'is-buy' : ''}`}>
        <p className="label">After the free-source checks</p>
        <h3>{view.decision.action === 'buy' ? `Buy one report, up to ${view.decision.proposal.maxUsdc} USDC` : 'Abstain: buy nothing'}</h3>
        <p>{view.decision.reason}</p>
        <details>
          <summary className="label">Decision log ({view.decision.freeChecks.length})</summary>
          <ol className="log">{view.decision.freeChecks.map((line: string, i: number) => <li key={i}>{line}</li>)}</ol>
        </details>
      </div>
    </>
  );
}

function States({view}: {view: Json}) {
  const s = view.states;
  return (
    <div className="state-grid">
      <StateCell title="Quote" state={s.quote.state}>{s.quote.amountUsdc ? <p className="label">{s.quote.amountUsdc} USDC, expires {s.quote.expiresAtUtc}</p> : null}</StateCell>
      <StateCell title="Policy" state={s.policy.state}><p className="label">{s.policy.reason ?? (s.policy.tier ? `Tier: ${s.policy.tier}` : '')}</p></StateCell>
      <StateCell title="Owner approval" state={s.approval.state}><p className="label">{s.approval.reason ?? s.approval.by ?? ''}</p></StateCell>
      <StateCell title="Verified delivery" state={s.delivery.state}>
        <p className="label">{s.delivery.state === 'verified' ? `Receipt signature, request binding and bytes match. Content ${short(s.delivery.contentHash)}` : s.delivery.code ? `${s.delivery.code}: ${s.delivery.reason}` : (s.delivery.state === 'received_unverified' ? 'Bytes received, not yet checked.' : '')}</p>
      </StateCell>
      <StateCell title="Settlement" state={s.settlement.state}>
        <p className="label">{s.settlement.txHash ? <>Tx <a href={`${EXPLORER}${s.settlement.txHash}`} rel="noreferrer" target="_blank">{short(s.settlement.txHash)}</a>. </> : null}{s.settlement.label ?? ''}</p>
      </StateCell>
      <StateCell title="Reconciliation" state={s.reconciliation.state}><p className="label">{s.reconciliation.deadlineUtc ? `Delivery due by ${s.reconciliation.deadlineUtc}` : ''}</p></StateCell>
      <StateCell title="Reassessment" state={s.reassessment.state}>
        {s.reassessment.after ? (
          <p className="label">{s.reassessment.before.total} {s.reassessment.before.final} → {s.reassessment.after.total} {s.reassessment.after.final}. {s.reassessment.reason}</p>
        ) : (
          <p className="label">{s.reassessment.state === 'ready' ? 'The verified bytes can be read now.' : 'Runs only after the receipt and the delivered bytes are verified.'}</p>
        )}
      </StateCell>
    </div>
  );
}

/* ---------- operator ---------- */

async function walletSignature(typed: Json): Promise<string> {
  const eth = (window as Json).ethereum;
  if (!eth) throw new Error('No browser wallet found. The owner signs in their own wallet.');
  const [account] = await eth.request({method: 'eth_requestAccounts'});
  const data = {
    types: {
      EIP712Domain: [
        {name: 'name', type: 'string'},
        {name: 'version', type: 'string'},
        {name: 'chainId', type: 'uint256'},
        {name: 'verifyingContract', type: 'address'},
      ],
      ...typed.types,
    },
    domain: typed.domain,
    primaryType: typed.primaryType,
    message: typed.message,
  };
  return eth.request({method: 'eth_signTypedData_v4', params: [account, JSON.stringify(data)]});
}

function Operator({view, token, onStep, onPause, busy}: {view: Json; token: string; onStep: (action: string, body?: Json) => void; onPause: (paused: boolean) => void; busy: boolean}) {
  const op = view.operator;
  if (!op) return null;
  const s = view.states;
  const b = op.budget;
  const act = (action: string, label: string, enabled: boolean, body?: Json, primary = false) => (
    <button key={action + label} className={`btn ${primary ? 'btn-gold' : 'btn-line'} btn-sm`} type="button" disabled={busy || !enabled || !token} onClick={() => onStep(action, body)}>{label}</button>
  );
  const paid = op.attempts.length > 0;
  const settledByMerchant = op.settleCalls > 0;
  return (
    <div className="op-panel">
      <div className="op-head">
        <h3>Operator review</h3>
        <p className="label">FIXTURE clock {op.fixtureClockUtc} · purchase {op.purchaseId ?? '—'}</p>
        <button className={`btn btn-sm ${op.paused ? 'btn-gold' : 'btn-line'}`} type="button" disabled={busy} onClick={() => onPause(!op.paused)}>{op.paused ? 'Resume payments' : 'Pause payments'}</button>
      </div>

      <div className="step-row">
        {act('quote', '1 · Request quote', view.decision.action === 'buy' && s.quote.state === 'not_requested', undefined, true)}
        {act('decide', '2 · Apply policy', s.quote.state === 'issued' && s.policy.state === 'not_decided', undefined, true)}
        {act('pay', '3 · Submit payment', s.authorization.state === 'signed' && !paid, undefined, true)}
        {act('verify', '4 · Verify receipt and bytes', paid, undefined, true)}
        {act('webhook', '5 · Observe on chain', settledByMerchant && op.webhooks.length === 0, undefined, true)}
        {act('reassess', '6 · Reassess', s.reassessment.state === 'ready', undefined, true)}
      </div>
      <div className="step-row">
        {act('retry', 'Retry payment', paid)}
        {act('webhook-replay', 'Replay event', op.webhooks.length > 0)}
        {act('webhook-forged', 'Send forged event', op.webhooks.length > 0)}
        {act('webhook-stale', 'Send stale event', op.webhooks.length > 0)}
        {act('advance', 'Clock +301 s', s.quote.state === 'issued', {seconds: 301})}
        {act('overdue', 'Check overdue', settledByMerchant)}
        {act('overdue-replay', 'Replay overdue event', op.incidents.length > 0)}
      </div>

      <div className="run-two">
        <div>
          <h4 className="label">Evidence quote</h4>
          {op.quote ? (
            <dl className="kv">
              <dt>Item</dt><dd>{op.quote.catalogItemId}</dd>
              <dt>Merchant</dt><dd>{op.quote.merchantId}</dd>
              <dt>Amount</dt><dd>{s.quote.amountUsdc} USDC to {short(op.quote.payTo)}</dd>
              <dt>Content hash</dt><dd className="mono">{short(op.quote.expectedContentHash)}</dd>
              <dt>Expires</dt><dd>{s.quote.expiresAtUtc}</dd>
            </dl>
          ) : <p className="label">No quote yet.</p>}
          <h4 className="label">Policy decision</h4>
          {op.policy ? (
            <>
              <p><span className={`tag ${tone(s.policy.state)}`}>{words(s.policy.state)}</span></p>
              <p className="explain">{op.policy.explanation}</p>
              <p className="label">{op.policy.voice}</p>
            </>
          ) : <p className="label">Not decided.</p>}
        </div>
        <div>
          <h4 className="label">Budget, held funds included</h4>
          {b ? (
            <>
              <div className="budget-bar"><span style={{width: `${Math.min(100, ((Number(b.held) + Number(b.spent)) / Number(b.budget)) * 100)}%`}} /></div>
              <p className="label">Budget {Number(b.budget) / 1e6} · held {Number(b.held) / 1e6} · spent {Number(b.spent) / 1e6} · released {Number(b.released) / 1e6} · available {Number(b.available) / 1e6} USDC</p>
            </>
          ) : <p className="label">Opens with the quote.</p>}
          {op.approvalRequest ? (
            <div className="approval">
              <h4 className="label">Owner approval request</h4>
              <p>Sign for exactly this request: purchase {op.purchaseId}, request hash {short(op.approvalRequest.requestHash)}, {s.quote.amountUsdc} USDC, expires {op.approvalRequest.expiresAtUtc}.</p>
              <p className="label">Enrolled owner {short(op.approvalRequest.owner)}{op.approvalRequest.fixtureOwnerEnrolled ? ' (FIXTURE: Anvil test key #3)' : ''}</p>
              <div className="step-row">
                <button className="btn btn-gold btn-sm" type="button" disabled={busy} onClick={async () => {
                  try {
                    onStep('approve', {method: 'wallet', signature: await walletSignature(op.approvalRequest.typedData)});
                  } catch (error) {
                    onStep('__message', {message: (error as Error).message});
                  }
                }}>Sign in wallet</button>
                {op.approvalRequest.fixtureOwnerEnrolled ? act('approve', 'Approve with FIXTURE owner key', true, {method: 'fixture-owner'}) : null}
                {act('reject', 'Reject', true, {reason: 'declined in operator review'})}
              </div>
            </div>
          ) : null}
          {op.authorization ? (
            <dl className="kv">
              <dt>Authorization</dt><dd>{op.authorization.status}</dd>
              <dt>Request hash</dt><dd className="mono">{short(op.authorization.requestHash)}</dd>
              <dt>Nonce</dt><dd className="mono">{short(op.authorization.nonce)}</dd>
              <dt>Valid before</dt><dd>{op.authorization.validBeforeUtc}</dd>
              <dt>Merchant settle calls</dt><dd>{op.settleCalls}</dd>
              <dt>Ledger</dt><dd>{op.ledgerCounts ? `${op.ledgerCounts.settlements} settlement, ${op.ledgerCounts.deliveries} delivery, ${op.ledgerCounts.events} events` : '—'}</dd>
            </dl>
          ) : null}
        </div>
      </div>

      {(op.attempts.length > 0 || op.webhooks.length > 0 || op.incidents.length > 0) && (
        <div className="table-scroll">
          <table className="ledger-table">
            <thead><tr><th>FIXTURE time</th><th>Event</th><th>Result</th></tr></thead>
            <tbody>
              {op.attempts.map((a: Json, i: number) => (
                <tr key={`a${i}`}><td className="mono">{a.atUtc}</td><td>{a.kind === 'pay' ? 'Payment submitted' : 'Payment retried'}</td><td>HTTP {a.status}{a.reason ? ` · ${a.reason}` : ''} · authorization {a.authorizationReused ? 'reused' : 'signed once'}</td></tr>
              ))}
              {op.webhooks.map((w: Json, i: number) => (
                <tr key={`w${i}`}><td className="mono">{w.atUtc}</td><td>QuickNode delivery ({w.kind})</td><td className={w.httpStatus === 200 ? '' : 'tone-bad'}>HTTP {w.httpStatus}{w.duplicateEvent ? ' · duplicate event, nothing recorded twice' : ''}{w.outcomes.map((o: Json) => ` · ${o.kind}`).join('')}</td></tr>
              ))}
              {op.incidents.map((n: Json, i: number) => (
                <tr key={`n${i}`}><td className="mono">{n.atUtc}</td><td>Overdue alert to Grok routine model</td><td>{n.outcome}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {op.incidentCards.map((c: Json) => (
        <div className="gap-card is-open" key={c.incidentKey}>
          <p className="label">Incident · {c.label ?? 'LIVE'} · replays {c.replayCount}</p>
          <p>{c.status}: {c.amount}, {c.merchantLabel}, due {c.deliveryDeadlineUtc}. Tx {short(c.txHash)}.</p>
        </div>
      ))}
    </div>
  );
}

/* ---------- page ---------- */

export default function Run() {
  const [mode, setMode] = useState<Mode>('loading');
  const [config, setConfig] = useState<Json>(null);
  const [markets, setMarkets] = useState<Json[]>([]);
  const [tab, setTab] = useState<'fixture' | 'live'>('fixture');
  const [selected, setSelected] = useState('fx-nyc-high-20261118');
  const [scenario, setScenario] = useState('standard');
  const [view, setView] = useState<Json>(null);
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? '');
  const [draft, setDraft] = useState(token);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const loadConfig = useCallback(async (t: string) => {
    try {
      const [c, m] = await Promise.all([api('/config', {token: t}), api('/markets')]);
      if (c.status !== 200 || m.status !== 200) throw new Error('no api');
      setConfig(c.json);
      setMarkets(m.json.markets);
      setMode('connected');
      return c.json;
    } catch {
      setConfig({role: 'visitor', scenarios: preview.scenarios, capabilities: preview.capabilities, gateway: null});
      setMarkets(preview.markets);
      setMode('preview');
      return null;
    }
  }, []);
  useEffect(() => void loadConfig(token), [loadConfig, token]);

  const operator = config?.role === 'operator';
  const scenarios: Json[] = config?.scenarios ?? [];

  async function startRun() {
    setMessage('');
    if (mode === 'preview') {
      const recorded = (preview.runs as Json[]).find((r) => r.market.contractId === selected && (r.scenario.id === scenario || r.decision.action === 'abstain'));
      setView(recorded ?? null);
      setMessage(recorded ? 'Recorded fixture run (read-only preview).' : 'No recorded run for this choice. Start npm run app to run it.');
      return;
    }
    setBusy(true);
    const {status, json} = await api('/runs', {method: 'POST', body: {marketId: selected, scenario}, token: operator ? token : undefined});
    setBusy(false);
    if (status !== 201) return setMessage(json.error ?? `Run failed (${status}).`);
    setView(json);
  }

  async function step(action: string, body: Json = {}) {
    if (action === '__message') return setMessage(body.message);
    if (!view) return;
    setBusy(true);
    const {status, json} = await api(`/operator/runs/${view.id}/${action}`, {method: 'POST', body, token});
    if (status === 200) {
      setView(json);
      setMessage('');
    } else {
      const fresh = await api(`/runs/${view.id}`, {token});
      if (fresh.status === 200) setView(fresh.json);
      setMessage(json.error ?? `Step refused (${status}).`);
    }
    setBusy(false);
  }

  async function pause(paused: boolean) {
    setBusy(true);
    const {status, json} = await api('/operator/pause', {method: 'POST', body: {paused, reason: 'operator switch'}, token});
    if (status !== 200) setMessage(json.error ?? 'Pause refused.');
    if (view) {
      const fresh = await api(`/runs/${view.id}`, {token});
      if (fresh.status === 200) setView(fresh.json);
    }
    setBusy(false);
  }

  const market = useMemo(() => markets.find((m) => m.contractId === selected), [markets, selected]);

  return (
    <main id="run" className="ledger-page run-page">
      <section className="sec">
        <div className="container">
          <header className="sec-head">
            <p className="sec-no">I</p>
            <div>
              <h2>Run one market.</h2>
              <p className="lead">Pick a Gemini Exchange market. Verity quotes the rule, scores settlement risk, checks free sources, then buys one report or abstains.</p>
            </div>
          </header>

          <p className="label ledger-note">
            {mode === 'loading' ? 'Connecting to the app server…' : mode === 'connected'
              ? <><span className="tag tone-good">App server connected</span> Fixture runs need no keys. {operator ? 'Signed in as operator.' : 'Visitors see analysis and states; payment steps need the operator token.'}</>
              : <><span className="tag tone-warn">FIXTURE preview</span> No app server answered, so this page shows recorded fixture runs. Start <code>npm run app</code> for live steps.</>}
          </p>

          <div className="run-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'fixture'} className={`btn btn-sm ${tab === 'fixture' ? 'btn-gold' : 'btn-line'}`} type="button" onClick={() => setTab('fixture')}>Fixture markets</button>
            <button role="tab" aria-selected={tab === 'live'} className={`btn btn-sm ${tab === 'live' ? 'btn-gold' : 'btn-line'}`} type="button" disabled={mode !== 'connected'} onClick={() => setTab('live')}>Live, read-only</button>
          </div>

          {tab === 'fixture' ? (
            <>
              <FixtureMarkets markets={markets} selected={selected} onSelect={setSelected} />
              <div className="run-form">
                <label className="label" htmlFor="scenario">Scenario</label>
                <select id="scenario" value={scenario} onChange={(e) => setScenario(e.target.value)}>
                  {scenarios.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
                <button className="btn btn-gold" type="button" disabled={busy || !market || mode === 'loading'} onClick={() => void startRun()}>Run this market</button>
              </div>
              <p className="label">{scenarios.find((s) => s.id === scenario)?.detail}</p>
            </>
          ) : <LiveMarkets />}
          {message ? <p className="label ledger-note run-message" role="status">{message}</p> : null}
        </div>
      </section>

      {view && (
        <>
          <section className="sec">
            <div className="container">
              <header className="sec-head">
                <p className="sec-no">II</p>
                <div>
                  <h2>The reading.</h2>
                  <p className="lead">{view.market.question}</p>
                </div>
              </header>
              <Reading view={view} />
            </div>
          </section>

          <section className="sec">
            <div className="container">
              <header className="sec-head">
                <p className="sec-no">III</p>
                <div>
                  <h2>Paid, delivered, settled.</h2>
                  <p className="lead">Three separate states. The evidence is read only after the buyer verifies the receipt and the bytes.</p>
                </div>
              </header>
              <States view={view} />
              {mode === 'connected' && !operator ? (
                <form className="ledger-gate" onSubmit={(e) => {
                  e.preventDefault();
                  sessionStorage.setItem(TOKEN_KEY, draft.trim());
                  setToken(draft.trim());
                }}>
                  <label className="label" htmlFor="op-token">Operator token</label>
                  <input id="op-token" type="password" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} />
                  <button className="btn btn-gold" type="submit">Sign in</button>
                </form>
              ) : null}
              {operator && !view.operator ? (
                <p className="label">This run was started as a visitor. <button className="btn btn-line btn-sm" type="button" onClick={async () => {
                  const fresh = await api(`/runs/${view.id}`, {token});
                  if (fresh.status === 200) setView(fresh.json);
                }}>Open operator view</button></p>
              ) : null}
              <Operator view={view} token={token} onStep={(a, b) => void step(a, b)} onPause={(p) => void pause(p)} busy={busy} />
              <details className="timeline">
                <summary className="label">Run timeline ({view.timeline.length})</summary>
                <ol className="log">{view.timeline.map((t: Json, i: number) => <li key={i}><span className="mono">{t.atUtc} · {t.actor} · {t.step}</span> {t.detail}</li>)}</ol>
              </details>
            </div>
          </section>
        </>
      )}

      <section className="sec">
        <div className="container">
          <header className="sec-head">
            <p className="sec-no">IV</p>
            <div>
              <h2>What is proven.</h2>
              <p className="lead">Each capability is labeled by the evidence behind it.</p>
            </div>
          </header>
          <div className="table-scroll">
            <table className="ledger-table">
              <thead><tr><th>Capability</th><th>State</th><th>Evidence or missing step</th></tr></thead>
              <tbody>
                {(config?.capabilities ?? []).map((c: Json) => (
                  <tr key={c.id}><td>{c.name}</td><td><span className={`tag ${c.state.startsWith('blocked') ? 'tone-bad' : c.state.startsWith('live') ? 'tone-good' : 'tone-warn'}`}>{c.state}</span></td><td>{c.detail}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {config?.gateway ? (
            <div className="gateway">
              <h3 className="ledger-sub">Circle Gateway purchase (opt-in)</h3>
              <p className="label">{config.gateway.label}</p>
              <dl className="kv">
                <dt>Circle transfer ID</dt><dd className="mono">{config.gateway.circleTransferId}</dd>
                <dt>Arc batch transaction</dt><dd className="mono"><a href={`${config.gateway.explorer}${config.gateway.arcBatchTx}`} rel="noreferrer" target="_blank">{config.gateway.arcBatchTx}</a> ({config.gateway.batchStatus})</dd>
                <dt>Amount</dt><dd>{config.gateway.amountUsdc} USDC · purchase {config.gateway.purchaseId}</dd>
                <dt>QuickNode</dt><dd>{config.gateway.quicknode?.status}: {config.gateway.quicknode?.reason}</dd>
              </dl>
              <p className="label">{config.gateway.note}</p>
            </div>
          ) : null}
          {config?.arc ? <p className="label ledger-note">Arc Testnet chain {config.arc.chainId} · USDC {config.arc.usdc} · Gateway Wallet {config.arc.gatewayWallet}</p> : null}
        </div>
      </section>

      <section className="sec" id="research-history">
        <div className="container">
          <header className="sec-head">
            <p className="sec-no">V</p>
            <div>
              <h2>Recorded history.</h2>
              <p className="lead">Every quote and assessment version stored for the selected market. A reassessment is added, never written over.</p>
            </div>
          </header>
          <ResearchHistory contractId={selected} />
        </div>
      </section>
    </main>
  );
}
