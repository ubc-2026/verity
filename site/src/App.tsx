import {useMemo, useRef, useState} from 'react';
import {gsap} from 'gsap';
import {ScrollTrigger} from 'gsap/ScrollTrigger';
import {SplitText as GSAPSplitText} from 'gsap/SplitText';
import {useGSAP} from '@gsap/react';
import Magnet from './bits/Magnet';
import Coin3D from './Coin3D';

gsap.registerPlugin(ScrollTrigger, GSAPSplitText, useGSAP);

/* Every number on this page is from the real reading of Nov 18, 2026. */

const reading = [
  {k: 'Ambiguity', n: 2, why: '2°F bands, and a word missing from the revision rule.'},
  {k: 'Source', n: 2, why: 'The NWS report can be issued early, then corrected.'},
  {k: 'Liquidity', n: 3, why: '$7 traded, with a 4¢ spread.'},
  {k: 'Correlation', n: 1, why: 'A stand-alone outcome.'},
];

const steps = [
  {t: 'Read', b: 'Pull the live market and its terms. Quote the rule that decides the payout.'},
  {t: 'Score', b: 'Four risks, 1 to 3 each. Every score cites the lines it came from.'},
  {t: 'Find the gap', b: 'Name the open question. Check free official sources first.'},
  {t: 'Pay', b: 'A separate service checks tier, allowlist and budget, then signs.'},
  {t: 'Reconcile', b: 'Match the USDC transfer to the request and the delivery.'},
];

const markets = {
  cols: ['Atlanta vs Oklahoma City, moneyline', 'NYC high temperature, 62 to 63°F'],
  rows: [
    ['Ambiguity', [1, 'Win or lose, official final score'], [2, '2°F bands and a missing word']],
    ['Source', [1, 'League result, then ESPN and Fox Sports'], [2, 'NWS report can be issued early, then corrected']],
    ['Liquidity', [1, '$1,392 traded, 1¢ spread'], [3, '$7 traded, 4¢ spread']],
    ['Correlation', [3, 'Five other markets on the same game'], [1, 'Stand-alone outcome']],
  ] as [string, [number, string], [number, string]][],
  totals: [
    [6, 'Low', 'Nothing to buy.'],
    [8, 'Medium', 'One 0.05 USDC report proposed.'],
  ] as [number, string, string][],
};

const tiers = [
  {range: '0.01 to 0.10', from: 0, to: 0.1, label: 'Automatic', rest: 'after the shared checks', tone: 'good'},
  {range: '0.11 to 0.50', from: 0.1, to: 0.5, label: 'Automatic', rest: 'only for an open gap', tone: 'good'},
  {range: '0.51 to 2.00', from: 0.5, to: 2, label: 'Owner approval', rest: 'explained by voice, signed by wallet', tone: 'warn'},
  {range: 'Over 2.00', from: 2, to: 2.5, label: 'Rejected', rest: 'no purchase is made', tone: 'bad'},
];

const stack = [
  ['Gemini Exchange', 'Market data and contract terms'],
  ['x402 and EIP-3009', 'Quotes bound to the exact request'],
  ['USDC on Arc Testnet', 'Settlement for each purchase'],
  ['QuickNode Streams', 'On-chain records for the ledger'],
  ['ElevenLabs', 'Voice for owner approvals'],
];

/* ---------- engraving ---------- */

/** A guilloche rosette, drawn the way banknote borders are: overlapping sine bands round a circle. */
function Guilloche({className = '', bands = 5, petals = 18}: {className?: string; bands?: number; petals?: number}) {
  const paths = useMemo(() => {
    const out: string[] = [];
    for (let b = 0; b < bands; b++) {
      const base = 120 + b * 34;
      for (let k = 0; k < 3; k++) {
        let d = '';
        for (let i = 0; i <= 720; i++) {
          const a = (i / 720) * Math.PI * 2;
          const r = base + 12 * Math.sin(a * (petals + b * 2) + (k * Math.PI * 2) / 3) + 5 * Math.sin(a * 3 + b);
          d += `${i ? 'L' : 'M'}${(300 + r * Math.cos(a)).toFixed(1)} ${(300 + r * Math.sin(a)).toFixed(1)}`;
        }
        out.push(d + 'Z');
      }
    }
    return out;
  }, [bands, petals]);
  return (
    <svg className={`guilloche ${className}`} viewBox="0 0 600 600" aria-hidden="true">
      {paths.map((d, i) => (
        <path key={i} d={d} pathLength={1} />
      ))}
    </svg>
  );
}

function Pips({n, max = 3}: {n: number; max?: number}) {
  return (
    <span className="pips" role="img" aria-label={`${n} of ${max}`}>
      {Array.from({length: max}, (_, i) => (
        <span key={i} className={i < n ? 'on' : ''} />
      ))}
    </span>
  );
}

function Seal() {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
      <defs>
        <linearGradient id="seal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--color-gold-hi)" />
          <stop offset=".55" stopColor="var(--color-gold)" />
          <stop offset="1" stopColor="var(--color-bronze)" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="14.5" fill="none" stroke="url(#seal)" strokeWidth="1" strokeDasharray="1.4 1.4" />
      <circle cx="16" cy="16" r="11.5" fill="url(#seal)" />
      <path d="m11 12 5 9 5-9" fill="none" stroke="var(--coin-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Arrow() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 10h11m-4-4 4 4-4 4" />
    </svg>
  );
}

function Microprint({text}: {text: string}) {
  const line = Array.from({length: 12}, () => text).join('  ◆  ');
  return (
    <div className="microprint" aria-hidden="true">
      <span>{line}</span>
      <span>{line}</span>
    </div>
  );
}

/* ---------- sections ---------- */

function Spending() {
  const [amount, setAmount] = useState(0.05);
  const tier = tiers.findIndex((t) => amount <= t.to);
  const t = tiers[tier];
  const pct = (v: number) => `${(v / 2.5) * 100}%`;
  return (
    <section id="spending" className="sec">
      <div className="container">
        <header className="sec-head">
          <p className="sec-no">IV</p>
          <div>
            <h2>The agent can’t spend past the owner’s rules.</h2>
            <p className="lead">A separate payment service holds the signer and checks every request against these tiers.</p>
          </div>
        </header>

        <div className="vault">
          <div className="vault-readout">
            <span className="label">Requested</span>
            <output className="vault-amount">{amount.toFixed(2)} <small>USDC</small></output>
            <span className={`verdict tone-${t.tone}`}>
              <strong>{t.label}</strong>, {t.rest}.
            </span>
          </div>

          <div className="scale">
            <div className="scale-track" aria-hidden="true">
              {tiers.map((x) => (
                <span key={x.label + x.from} className={`zone tone-${x.tone}`} style={{left: pct(x.from), width: pct(x.to - x.from)}} />
              ))}
              <span className="scale-fill" style={{width: pct(amount)}} />
              <span className="scale-thumb" style={{left: pct(amount)}} />
            </div>
            <input
              className="scale-input"
              type="range"
              min={0.01}
              max={2.5}
              step={0.01}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              aria-label="Requested amount in USDC"
            />
            <div className="scale-ticks" aria-hidden="true">
              {[0.1, 0.5, 2].map((v) => (
                <span key={v} style={{left: pct(v)}}>{v.toFixed(2)}</span>
              ))}
            </div>
          </div>

          <ol className="tier-list">
            {tiers.map((x, i) => (
              <li key={x.label + x.from} className={i === tier ? 'is-on' : ''}>
                <span className="mono">{x.range} USDC</span>
                <span><strong>{x.label}</strong>, {x.rest}</span>
              </li>
            ))}
          </ol>

          <div className="budget">
            <span className="label">Mission budget</span>
            <span className="budget-bar" aria-hidden="true"><span style={{width: `${Math.min(100, (amount / 25) * 100)}%`}} /></span>
            <span className="mono">{amount.toFixed(2)} of 25.00 USDC, on testnet</span>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- page ---------- */

export default function App() {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        // Opening: the engraving draws itself, then the type and the certificate strip.
        const split = new GSAPSplitText('.hero h1', {type: 'lines', mask: 'lines'});
        gsap
          .timeline({delay: 0.2})
          .fromTo('.hero .guilloche path', {strokeDashoffset: 1, strokeDasharray: 1}, {strokeDashoffset: 0, duration: 2.4, ease: 'power2.inOut', stagger: 0.03}, 0)
          .from('.top', {opacity: 0, y: -12, duration: 0.6, ease: 'power2.out'}, 0.1)
          .from('.hero .eyebrow', {opacity: 0, y: 10, duration: 0.5}, 0.3)
          .from(split.lines, {yPercent: 105, duration: 1, ease: 'power4.out', stagger: 0.1}, 0.4)
          .from('.hero .lead, .hero .actions', {opacity: 0, y: 14, duration: 0.7, ease: 'power3.out', stagger: 0.1}, 0.9)
          .from('.cert-cell', {opacity: 0, y: 18, duration: 0.6, ease: 'power3.out', stagger: 0.08}, 1.1);

        gsap.to('.hero .guilloche', {rotation: 360, duration: 240, ease: 'none', repeat: -1, transformOrigin: '50% 50%'});

        // Section heads: the numeral, then the words.
        gsap.utils.toArray<HTMLElement>('.sec-head').forEach((el) => {
          const tl = gsap.timeline({scrollTrigger: {trigger: el, start: 'top 82%', once: true}});
          tl.from(el.querySelector('.sec-no'), {opacity: 0, x: -16, duration: 0.6, ease: 'power3.out'})
            .from(el.querySelectorAll('h2, .lead'), {opacity: 0, y: 22, duration: 0.8, ease: 'power3.out', stagger: 0.08}, 0.05);
        });

        // The reading: the highlight sweeps, the gap appears, the hallmarks are struck one by one.
        const r = gsap.timeline({scrollTrigger: {trigger: '.reading-grid', start: 'top 72%', once: true}});
        r.fromTo('.clause .hl', {backgroundSize: '0% 100%'}, {backgroundSize: '100% 100%', duration: 1.1, ease: 'power2.inOut'})
          .from('.clause .gap', {scale: 0, duration: 0.4, ease: 'back.out(3)'}, '-=0.2')
          .from('.margin-note', {opacity: 0, x: 20, duration: 0.6, ease: 'power3.out'})
          .from('.hallmark', {scale: 1.3, opacity: 0, rotation: -5, duration: 0.45, ease: 'power4.out', stagger: 0.14}, '-=0.2')
          .from('.total-stamp', {scale: 1.45, opacity: 0, rotation: 6, duration: 0.5, ease: 'power4.out'}, '+=0.05');

        // The ledger: the chain draws, blocks arrive, a packet runs it.
        const l = gsap.timeline({scrollTrigger: {trigger: '.ledger', start: 'top 75%', once: true}});
        l.from('.ledger-line > span', {scaleX: 0, duration: 1.4, ease: 'power2.inOut'})
          .from('.ledger-block', {opacity: 0, y: 26, duration: 0.6, ease: 'power3.out', stagger: 0.1}, 0.1)
          .fromTo('.ledger-packet', {left: '0%'}, {left: '100%', duration: 5, ease: 'none', repeat: -1}, 1.2);

        gsap.from('.mk tbody tr, .mk tfoot tr', {opacity: 0, y: 18, duration: 0.6, ease: 'power3.out', stagger: 0.08, scrollTrigger: {trigger: '.mk', start: 'top 78%', once: true}});
        gsap.from('.stack-tile', {opacity: 0, y: 22, duration: 0.6, ease: 'power3.out', stagger: 0.07, scrollTrigger: {trigger: '.stack', start: 'top 85%', once: true}});
        gsap.from('.vault', {opacity: 0, y: 28, duration: 0.8, ease: 'power3.out', scrollTrigger: {trigger: '.vault', start: 'top 82%', once: true}});
        gsap.fromTo('.closing .guilloche path', {strokeDashoffset: 1, strokeDasharray: 1}, {strokeDashoffset: 0, duration: 2.2, ease: 'power2.inOut', stagger: 0.03, scrollTrigger: {trigger: '.closing', start: 'top 75%', once: true}});

        ScrollTrigger.create({start: 30, toggleClass: {targets: '.top', className: 'is-stuck'}});
        return () => split.revert();
      });
    },
    {scope: root},
  );

  return (
    <div className="page" ref={root}>
      <header className="top">
        <div className="container top-in">
          <a className="brand" href="#top">
            <Seal /> <span>Verity</span>
          </a>
          <nav aria-label="Page sections">
            <a href="#reading">The reading</a>
            <a href="#how">How it works</a>
            <a href="#markets">Markets</a>
            <a href="#spending">Spending</a>
          </nav>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <Guilloche className="hero-rosette" bands={6} />
          <div className="container hero-in">
            <div className="hero-copy">
              <p className="eyebrow mono">A research agent for prediction markets</p>
              <h1>Read the rules, then trust the price.</h1>
              <p className="lead">
                Verity reads how a market settles, scores the risk, and pays for missing evidence in USDC, with every payment
                recorded on-chain.
              </p>
              <div className="actions">
                <Magnet padding={40} magnetStrength={4}>
                  <a className="btn btn-gold" href="#reading">
                    See a real reading <Arrow />
                  </a>
                </Magnet>
                <a className="btn btn-line" href="#how">How it works</a>
              </div>
            </div>
            <div className="hero-coin">
              <Coin3D />
              <p className="coin-hint mono">Tap the coin to flip it</p>
            </div>
          </div>

          <div className="container">
            <dl className="cert-strip">
              <div className="cert-cell">
                <dt className="label">Market</dt>
                <dd>NYC high, 62 to 63°F</dd>
              </div>
              <div className="cert-cell">
                <dt className="label">Market price</dt>
                <dd className="big">56¢</dd>
              </div>
              <div className="cert-cell">
                <dt className="label">Verity risk</dt>
                <dd className="big">8<small> of 12</small> <span className="tag tone-warn">Medium</span></dd>
              </div>
              <div className="cert-cell">
                <dt className="label">Evidence proposed</dt>
                <dd className="big">0.05<small> USDC</small></dd>
              </div>
            </dl>
          </div>
        </section>

        <section id="reading" className="sec reading">
          <div className="container">
            <header className="sec-head">
              <p className="sec-no">I</p>
              <div>
                <h2>The fine print, read line by line.</h2>
                <p className="lead">A live Gemini Exchange weather market, read on Nov 18, 2026.</p>
              </div>
            </header>

            <div className="reading-grid">
              <article className="certificate">
                <div className="cert-head">
                  <span className="mono">Highest temperature in NYC, Nov 18</span>
                  <span className="mono muted">Settlement rule</span>
                </div>
                <p className="clause">
                  Settles on the NWS daily climate report for Central Park. If the report is revised or corrected,{' '}
                  <mark className="hl">
                    only the first published version that includes confirmation of the <span className="gap" aria-label="missing word" /> will
                    be used.
                  </mark>
                </p>
                <aside className="margin-note">
                  <span className="mono">Note</span>
                  <p>A word is missing. NWS can publish a partial 4 PM report and a full-day one, and the rule doesn’t say which counts.</p>
                </aside>
                <Microprint text="Verity reads the rules before it trusts the price" />
              </article>

              <div className="hallmarks">
                {reading.map((x) => (
                  <div className="hallmark" key={x.k}>
                    <div className="hallmark-top">
                      <span className="label">{x.k}</span>
                      <span className="hallmark-n">{x.n}</span>
                    </div>
                    <Pips n={x.n} />
                    <p>{x.why}</p>
                  </div>
                ))}
                <div className="total-stamp">
                  <span className="label">Total</span>
                  <span className="total-n">8<small>/12</small></span>
                  <span className="tag tone-warn">Medium, investigate</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="how" className="sec">
          <div className="container">
            <header className="sec-head">
              <p className="sec-no">II</p>
              <div>
                <h2>From contract text to an on-chain receipt.</h2>
                <p className="lead">Five blocks. Each one has to pass before the next is written.</p>
              </div>
            </header>
            <div className="ledger">
              <span className="ledger-line" aria-hidden="true">
                <span />
                <i className="ledger-packet" />
              </span>
              <ol>
                {steps.map((s, i) => (
                  <li className="ledger-block" key={s.t}>
                    <span className="ledger-node" aria-hidden="true"><b>{String(i + 1).padStart(2, '0')}</b></span>
                    <h3>{s.t}</h3>
                    <p>{s.b}</p>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        <section id="markets" className="sec">
          <div className="container">
            <header className="sec-head">
              <p className="sec-no">III</p>
              <div>
                <h2>Two live markets, one rubric.</h2>
                <p className="lead">The same four questions, asked of a basketball game and a weather report.</p>
              </div>
            </header>
            <div className="mk-wrap">
              <table className="mk">
                <thead>
                  <tr>
                    <th scope="col"><span className="visually-hidden">Risk</span></th>
                    {markets.cols.map((c) => (
                      <th scope="col" key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {markets.rows.map(([k, a, b]) => (
                    <tr key={k}>
                      <th scope="row" className="label">{k}</th>
                      {[a, b].map(([n, why], j) => (
                        <td key={j}>
                          <div className="cell">
                            <Pips n={n} />
                            <span>{why}</span>
                          </div>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" className="label">Total</th>
                    {markets.totals.map(([n, band, out], j) => (
                      <td key={j}>
                        <div className="cell cell-total">
                          <span className="total-n">{n}<small>/12</small></span>
                          <span className={`tag ${band === 'Low' ? 'tone-good' : 'tone-warn'}`}>{band}</span>
                          <span className="muted">{out}</span>
                        </div>
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </section>

        <Spending />

        <section id="stack" className="sec">
          <div className="container">
            <header className="sec-head">
              <p className="sec-no">V</p>
              <div>
                <h2>What it’s built on.</h2>
              </div>
            </header>
            <ul className="stack">
              {stack.map(([n, b]) => (
                <li className="stack-tile" key={n}>
                  <h3>{n}</h3>
                  <p>{b}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="closing">
          <Guilloche className="closing-rosette" bands={4} petals={14} />
          <div className="container closing-in">
            <h2>
              A price says how likely. <span className="leaf">The rules say what you’re buying.</span>
            </h2>
            <a className="btn btn-gold" href="#reading">
              See a real reading <Arrow />
            </a>
          </div>
        </section>
      </main>

      <footer className="foot">
        <Microprint text="Verity · A UBC 2026 hackathon prototype · No trades placed · Testnet payments" />
        <div className="container foot-in">
          <a className="brand" href="#top">
            <Seal /> <span>Verity</span>
          </a>
          <p>A UBC 2026 hackathon prototype. It places no trades and runs payments on testnet. Not affiliated with Gemini Exchange or the National Weather Service.</p>
        </div>
      </footer>
    </div>
  );
}
