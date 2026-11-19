import { ARC_EXPLORER_TX_BASE } from "./chain.ts";
import type { PurchaseView, UnmatchedPayment } from "./ledger.ts";

export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Verity audit ledger</title>
  <style>
    :root { color-scheme: light; font-family: "Iowan Old Style", Palatino, Georgia, serif; background: #f4f1ea; color: #1c1915; }
    body { margin: 0 auto; max-width: 1100px; padding: 32px 20px 64px; }
    h1 { font-weight: 500; font-size: 32px; margin: 0 0 8px; }
    p { line-height: 1.45; }
    form { display: flex; gap: 8px; margin: 20px 0; }
    input { flex: 1; font: 14px ui-monospace, monospace; padding: 8px 10px; border: 1px solid #c8c0b4; background: #fff; }
    button { font: 14px ui-sans-serif, system-ui, sans-serif; padding: 8px 12px; background: #1c1915; color: #f4f1ea; border: 0; }
    table { width: 100%; border-collapse: collapse; background: #fff; }
    th, td { text-align: left; vertical-align: top; padding: 10px 12px; border-bottom: 1px solid #e4ddd2; font-size: 14px; }
    th { font: 12px ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.04em; text-transform: uppercase; color: #655d54; }
    a { color: #1c1915; }
    .muted { color: #655d54; font: 13px ui-sans-serif, system-ui, sans-serif; }
    .status { font: 13px ui-sans-serif, system-ui, sans-serif; }
  </style>
</head>
<body>
  <h1>Audit ledger</h1>
  <p class="muted">Arc Testnet USDC settlements from QuickNode, matched to Verity purchases. The read token stays in this browser.</p>
  <form id="auth">
    <input id="token" type="password" autocomplete="off" placeholder="Read token">
    <button type="submit">Load</button>
  </form>
  <p id="message" class="muted"></p>
  <table>
    <thead>
      <tr><th>Purchase</th><th>Status</th><th>Amount</th><th>Settlement</th><th>Deadline</th></tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <h2>Unmatched</h2>
  <table>
    <thead><tr><th>Transaction</th><th>From</th><th>To</th><th>Amount</th><th>Detail</th></tr></thead>
    <tbody id="unmatched"></tbody>
  </table>
  <script>
    const explorer = ${JSON.stringify(ARC_EXPLORER_TX_BASE)};
    const tokenInput = document.querySelector("#token");
    const message = document.querySelector("#message");
    const stored = sessionStorage.getItem("verity-ledger-token");
    if (stored) tokenInput.value = stored;

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;", "'": "&#39;"
      }[ch]));
    }

    function txLink(hash) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash || "")) return "";
      const short = hash.slice(0, 10) + "…" + hash.slice(-4);
      return '<a href="' + explorer + hash + '">' + short + "</a>";
    }

    async function load(event) {
      if (event) event.preventDefault();
      const token = tokenInput.value.trim();
      sessionStorage.setItem("verity-ledger-token", token);
      const headers = { authorization: "Bearer " + token };
      const [purchasesRes, unmatchedRes] = await Promise.all([
        fetch("/purchases", { headers }),
        fetch("/unmatched", { headers }),
      ]);
      if (!purchasesRes.ok || !unmatchedRes.ok) {
        message.textContent = "Ledger refused the read token.";
        return;
      }
      const purchases = await purchasesRes.json();
      const unmatched = await unmatchedRes.json();
      message.textContent = purchases.purchases.length + " purchases";
      document.querySelector("#rows").innerHTML = purchases.purchases.map((row) =>
        "<tr><td>" + escapeHtml(row.purchaseId) + "<div class='muted'>" + escapeHtml(row.merchantLabel) + "</div></td>" +
        "<td class='status'>" + escapeHtml(row.ledgerStatus) + "<div class='muted'>" + escapeHtml(row.detail) + "</div></td>" +
        "<td>" + escapeHtml(row.amountBaseUnits) + "</td>" +
        "<td>" + txLink(row.txHash) + (row.settlementConfirmed ? "" : "<div class='muted'>unconfirmed</div>") + "</td>" +
        "<td>" + escapeHtml(row.deliveryDeadlineUtc) + "</td></tr>"
      ).join("");
      document.querySelector("#unmatched").innerHTML = unmatched.payments.map((row) =>
        "<tr><td>" + txLink(row.txHash) + "</td><td>" + escapeHtml(row.from) + "</td><td>" + escapeHtml(row.to) +
        "</td><td>" + escapeHtml(row.amountBaseUnits) + "</td><td>" + escapeHtml(row.detail) + "</td></tr>"
      ).join("");
    }

    document.querySelector("#auth").addEventListener("submit", load);
    if (stored) load();
    setInterval(() => { if (sessionStorage.getItem("verity-ledger-token")) load(); }, 4000);
  </script>
</body>
</html>`;
}

export function publicPurchase(view: PurchaseView) {
  return {
    purchaseId: view.purchaseId,
    environment: view.environment,
    amountBaseUnits: view.amountBaseUnits,
    ledgerStatus: view.ledgerStatus,
    settlementConfirmed: view.settlementConfirmed,
    deliveryDeadlineUtc: view.deliveryDeadlineUtc,
    merchantLabel: view.merchantLabel,
    detail: view.detail,
    ...(view.dataLabel ? { dataLabel: view.dataLabel } : {}),
    ...(view.txHash ? { txHash: view.txHash } : {}),
    ...(view.duplicateTxHash ? { duplicateTxHash: view.duplicateTxHash } : {}),
  };
}

export function publicUnmatched(payment: UnmatchedPayment) {
  return payment;
}
