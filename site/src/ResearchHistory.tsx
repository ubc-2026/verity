import {useEffect, useState} from 'react';
import preview from './research-preview.json';

/* Recorded history for one market: quotes over time and the assessment versions, from the read-only
   research API (/api/research). Without the app server, shows the recorded FIXTURE preview. */

type Json = any;
type State = {source: 'api' | 'preview'; detail: Json} | {source: 'none'} | null;

const pct = (v?: string | null) => (v == null ? '—' : `${Math.round(Number(v) * 1000) / 10}¢`);
const short = (v?: string | null) => (v ? `${v.slice(0, 12)}…${v.slice(-6)}` : '—');
const QUOTE_LABEL: Record<string, string> = {
  two_sided: 'Two-sided', one_sided_bid: 'Bid only', one_sided_ask: 'Ask only', missing: 'No quote',
  crossed: 'Crossed', closed: 'Closed', unavailable: 'Unavailable', stale: 'Stale', date_only: 'Date only',
};
const TONE: Record<string, string> = {
  two_sided: 'tone-good', one_sided_bid: 'tone-warn', one_sided_ask: 'tone-warn', missing: 'tone-bad', crossed: 'tone-bad',
  closed: 'muted', unavailable: 'tone-bad', stale: 'tone-warn', date_only: 'muted', FIXTURE: 'tone-warn', CAPTURED: 'tone-good', LIVE: 'tone-good',
};
const Tag = ({k}: {k: string}) => <span className={`tag ${TONE[k] ?? ''}`}>{QUOTE_LABEL[k] ?? k}</span>;
const rating = (r: Json) => `${r.total ?? '—'}/12 ${r.final ?? 'incomplete'}`;

async function load(contractId: string): Promise<State> {
  try {
    const alias = await fetch(`/api/research/aliases/${encodeURIComponent(contractId)}`);
    if (alias.status === 404) return {source: 'none'};
    if (alias.status !== 200) throw new Error('no api');
    const {key} = await alias.json();
    const res = await fetch(`/api/research/instruments/${[key.exchange, key.instrumentId, key.outcomeId].map(encodeURIComponent).join('/')}`);
    if (res.status !== 200) throw new Error('no detail');
    return {source: 'api', detail: await res.json()};
  } catch {
    return preview.alias === contractId ? {source: 'preview', detail: preview.detail} : {source: 'none'};
  }
}

export default function ResearchHistory({contractId}: {contractId: string}) {
  const [state, setState] = useState<State>(null);
  useEffect(() => {
    let live = true;
    setState(null);
    void load(contractId).then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, [contractId]);

  if (!state) return <p className="label">Loading recorded history…</p>;
  if (state.source === 'none') return <p className="lead">No research history is recorded for this market yet.</p>;
  const d = state.detail;
  const risk = d.resolutionRisk;
  const cmp = risk.comparison;
  const latest = risk.latest;
  const rules = d.sources.filter((s: Json) => s.kind === 'rules');

  return (
    <div className="research-history">
      <p className="label ledger-note">
        {state.source === 'preview'
          ? <><span className="tag tone-warn">Recorded preview</span> No app server answered. This is the stored history, read-only.</>
          : <><span className="tag tone-good">Research store</span> Read-only. Stored by the trusted server; visitors cannot write here.</>}
        {' '}{d.instrument.key.exchange} · <span className="mono">{d.instrument.key.outcomeId}</span>
      </p>

      <div className="run-two">
        <div>
          <h3>Market-implied price over time</h3>
          <p className="label">{d.market.note}</p>
          <div className="table-scroll">
            <table className="ledger-table">
              <thead><tr><th>Read at</th><th>Bid</th><th>Ask</th><th>Implied</th><th>State</th></tr></thead>
              <tbody>
                {d.market.history.map((q: Json) => (
                  <tr key={q.snapshotId}>
                    <td className="mono">{q.capturedAt ?? q.capturedDate}</td>
                    <td>{q.bestBid ?? '—'}</td>
                    <td>{q.bestAsk ?? '—'}</td>
                    <td>{pct(q.impliedProbability)}</td>
                    <td>{q.labels.map((l: string) => <Tag key={l} k={l} />)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="label">Now: <Tag k={d.market.current.freshness === 'current' ? (d.market.current.quoteState ?? 'unavailable') : d.market.current.freshness} /> {d.market.current.note}</p>
        </div>
        <div>
          <h3>Settlement-risk versions</h3>
          <p className="label">{risk.note}</p>
          {risk.versions.map((v: Json) => (
            <div className={`gap-card ${v.seq === latest?.seq ? 'is-open' : ''}`} key={v.seq}>
              <p className="label">
                Version {v.seq}{v.parentSeq ? ` · revises version ${v.parentSeq}` : ' · original'} · {v.assessedAt} · <Tag k={v.dataLabel} />
              </p>
              <p><strong>{rating(v.rating)}</strong> · decision: {v.decision.replace(/_/g, ' ')}</p>
              <p className="label">Rubric {v.rubricVersion} · {v.analystId}{v.trigger ? ` · evidence ${v.trigger.sourceKey} v${v.trigger.version}, ${v.trigger.verification}` : ''}</p>
            </div>
          ))}
        </div>
      </div>

      {cmp ? (
        <div className={`verdict-card ${cmp.traceable ? 'is-buy' : ''}`}>
          <p className="label">Before and after verified evidence</p>
          <h3>{rating(cmp.before)} → {rating(cmp.after)}</h3>
          <ul className="log">
            {cmp.changedFindings.map((c: Json) => <li key={c.finding}><span className="mono">{c.finding}</span>: {c.before} → {c.after}. {c.reason}</li>)}
          </ul>
          <p className="label">
            {cmp.evidence ? <>Traced to <span className="mono">{cmp.evidence.sourceKey}</span> v{cmp.evidence.version}, {cmp.evidence.verification}, sha256 <span className="mono">{short(cmp.evidence.contentSha256)}</span>. </> : null}
            {cmp.traceable ? 'Every changed finding rests on verified evidence.' : 'A changed finding has no verified evidence.'}
          </p>
        </div>
      ) : null}

      {latest ? (
        <div className="run-two">
          <div>
            <h3>Cited findings (version {latest.seq})</h3>
            {latest.citedClaims.map((c: Json, i: number) => (
              <blockquote className="rule-quote" key={`${c.category}-${c.citationId}-${i}`}>
                <p className="mono">{c.category} · {c.citationId} · {c.sourceKey} v{c.sourceVersion} · {c.supported ? 'quote found in source' : 'quote not found in source'}</p>
                <p>“{c.quote}”</p>
              </blockquote>
            ))}
          </div>
          <div>
            <h3>The rules, as stored</h3>
            {rules.map((s: Json) => (
              <details key={`${s.sourceKey}-${s.version}`} open>
                <summary className="label">{s.sourceKey} · version {s.version} · <Tag k={s.dataLabel} /></summary>
                <pre className="research-text">{s.text}</pre>
              </details>
            ))}
            {latest.evidenceGap ? (
              <div className="gap-card">
                <p className="label">{latest.evidenceGap.id} · the gap the evidence answered</p>
                <p>{latest.evidenceGap.question}</p>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
