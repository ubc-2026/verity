import {useEffect, useState} from 'react';

const EXPLORER = 'https://explorer.testnet.arc.io/tx/';

type ChainLog = {
  blockNumber: number;
  txHash: string;
  kind: 'transfer' | 'authorization';
  from: string;
  to: string | null;
  amountBaseUnits: string | null;
  nonce: string | null;
};

type Purchase = {
  purchaseId: string;
  rail: 'arc-eip3009' | 'circle-gateway-batched';
  merchantLabel: string;
  amountBaseUnits: string;
  ledgerStatus: string;
  detail: string;
  txHash: string | null;
  quicknode: 'matched' | 'waiting' | 'not_claimed';
};

function short(value: string | null): string {
  if (!value) return '—';
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function usdc(units: string | null): string {
  if (!units) return '—';
  const amount = Number(units) / 1_000_000;
  if (!Number.isFinite(amount)) return units;
  return amount.toLocaleString(undefined, {maximumFractionDigits: 6});
}

function tone(status: string): string {
  if (status === 'Reconciled') return 'tone-good';
  if (status === 'Mismatch' || status === 'Duplicate payment') return 'tone-bad';
  if (status === 'Paid, delivery missing' || status === 'Delivered, payment unconfirmed') return 'tone-warn';
  return '';
}

export default function Portal() {
  const [token, setToken] = useState(() => sessionStorage.getItem('verity-portal-token') ?? '');
  const [draft, setDraft] = useState(token);
  const [limit, setLimit] = useState(100);
  const [logs, setLogs] = useState<ChainLog[]>([]);
  const [total, setTotal] = useState(0);
  const [head, setHead] = useState(0);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [message, setMessage] = useState(token ? 'Loading the ledger…' : 'Enter the portal read token.');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (token) void load(token, limit);
    // Load once when a token is already stored in this browser.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(nextToken = token, nextLimit = limit) {
    const trimmed = nextToken.trim();
    if (!trimmed) {
      setMessage('Enter the portal read token.');
      return;
    }
    sessionStorage.setItem('verity-portal-token', trimmed);
    setToken(trimmed);
    const headers = {authorization: `Bearer ${trimmed}`};
    try {
      const [activityRes, purchaseRes] = await Promise.all([
        fetch(`/portal-api/activity?limit=${nextLimit}`, {headers}),
        fetch('/portal-api/purchases', {headers}),
      ]);
      if (activityRes.status === 401 || purchaseRes.status === 401) {
        setMessage('The portal refused that read token.');
        return;
      }
      if (!activityRes.ok || !purchaseRes.ok) {
        setMessage('The portal did not answer. Start it on this machine, then try again.');
        return;
      }
      const activity = await activityRes.json();
      const purchaseBody = await purchaseRes.json();
      setLogs(activity.logs);
      setTotal(activity.observations);
      setHead(activity.head);
      setPurchases(purchaseBody.purchases);
      setLoaded(true);
      setMessage(`Showing ${activity.logs.length} of ${activity.observations} USDC logs. Chain head ${activity.head}.`);
    } catch {
      setMessage('The portal did not answer. Start it on this machine, then try again.');
    }
  }

  return (
    <main id="ledger" className="ledger-page">
      <section className="sec">
        <div className="container">
          <header className="sec-head">
            <p className="sec-no">V</p>
            <div>
              <h2>The ledger the stream fills.</h2>
              <p className="lead">USDC logs from QuickNode on Arc Testnet, then the purchases those logs can match.</p>
            </div>
          </header>

          <form
            className="ledger-gate"
            onSubmit={(event) => {
              event.preventDefault();
              void load(draft, limit);
            }}
          >
            <label className="label" htmlFor="portal-token">Read token</label>
            <input
              id="portal-token"
              type="password"
              autoComplete="off"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button className="btn btn-gold" type="submit">Load</button>
          </form>
          <p className="label ledger-note">{message}</p>

          {loaded && (
            <>
              <div className="table-scroll">
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th>Block</th>
                      <th>Transaction</th>
                      <th>Log</th>
                      <th>From</th>
                      <th>To</th>
                      <th>USDC</th>
                      <th>Nonce</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((row) => (
                      <tr key={`${row.txHash}-${row.kind}-${row.blockNumber}-${row.nonce ?? ''}-${row.from}`}>
                        <td className="mono">{row.blockNumber}</td>
                        <td><a href={`${EXPLORER}${row.txHash}`}>{short(row.txHash)}</a></td>
                        <td>{row.kind === 'authorization' ? 'Authorization' : 'Transfer'}</td>
                        <td className="mono">{short(row.from)}</td>
                        <td className="mono">{short(row.to)}</td>
                        <td className="mono">{usdc(row.amountBaseUnits)}</td>
                        <td className="mono">{short(row.nonce)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {logs.length < total && (
                <button
                  className="btn btn-line ledger-more"
                  type="button"
                  onClick={() => {
                    const next = Math.min(500, limit + 100);
                    setLimit(next);
                    void load(token, next);
                  }}
                >
                  Show more
                </button>
              )}

              <h3 className="ledger-sub">Purchases</h3>
              <p className="lead">A direct USDC payment can reconcile. A Gateway nanopayment stays unclaimed.</p>
              <div className="table-scroll">
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th>Purchase</th>
                      <th>Rail</th>
                      <th>Status</th>
                      <th>USDC</th>
                      <th>Chain</th>
                    </tr>
                  </thead>
                  <tbody>
                    {purchases.map((row) => (
                      <tr key={row.purchaseId}>
                        <td>
                          {row.purchaseId}
                          <div className="label">{row.merchantLabel}</div>
                        </td>
                        <td>{row.rail === 'circle-gateway-batched' ? 'Gateway nanopayment' : 'Direct USDC'}</td>
                        <td className={tone(row.ledgerStatus)}>
                          <strong>{row.ledgerStatus}</strong>
                          <div className="label">{row.detail}</div>
                        </td>
                        <td className="mono">{usdc(row.amountBaseUnits)}</td>
                        <td>
                          {row.quicknode === 'not_claimed' || !row.txHash
                            ? 'Not claimed'
                            : <a href={`${EXPLORER}${row.txHash}`}>{short(row.txHash)}</a>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="label ledger-note">Chain head {head}.</p>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
