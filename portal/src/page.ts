import type { PortalPurchase, UnmatchedObservation } from "./store.ts";

export function portalHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Verity payment portal</title>
  <style>
    :root { color-scheme: light; font-family: "Iowan Old Style", Palatino, Georgia, serif; background: #f4f1ea; color: #1c1915; }
    body { margin: 0 auto; max-width: 1100px; padding: 32px 20px 64px; }
    h1 { font-weight: 500; font-size: 32px; margin: 0 0 8px; }
    p { line-height: 1.45; }
    form { display: flex; gap: 8px; margin: 20px 0; }
    input { flex: 1; font: 14px ui-monospace, monospace; padding: 8px 10px; border: 1px solid #c8c0b4; background: #fff; }
    button { font: 14px ui-sans-serif, system-ui, sans-serif; padding: 8px 12px; background: #1c1915; color: #f4f1ea; border: 0; }
    table { width: 100%; border-collapse: collapse; background: #fff; margin-bottom: 28px; }
    th, td { text-align: left; vertical-align: top; padding: 10px 12px; border-bottom: 1px solid #e4ddd2; font-size: 14px; }
    th { font: 12px ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.04em; text-transform: uppercase; color: #655d54; }
    a { color: #1c1915; }
    .muted { color: #655d54; font: 13px ui-sans-serif, system-ui, sans-serif; }
  </style>
</head>
<body>
  <h1>QuickNode feed</h1>
  <p class="muted">USDC transfers and authorization tickets arriving from the Arc Testnet stream. Newest first.</p>
  <form id="auth">
    <input id="token" type="password" autocomplete="off" placeholder="Read token">
    <button type="submit">Load</button>
  </form>
  <p id="message" class="muted"></p>
  <table>
    <thead>
      <tr><th>Block</th><th>Transaction</th><th>Log</th><th>From</th><th>To</th><th>Amount</th><th>Nonce</th></tr>
    </thead>
    <tbody id="logs"></tbody>
  </table>
  <p><button id="more" type="button">Show more</button></p>
  <h2>Purchases</h2>
  <p class="muted">Nanopayment purchases matched against the logs above. Gateway rows stay unclaimed.</p>
  <table>
    <thead>
      <tr><th>Purchase</th><th>Rail</th><th>Status</th><th>Amount</th><th>Chain</th></tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <script>
    const explorer = "https://explorer.testnet.arc.io/tx/";
    const tokenInput = document.querySelector("#token");
    const message = document.querySelector("#message");
    const stored = sessionStorage.getItem("verity-portal-token");
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

    function short(value) {
      if (!value) return "";
      return value.slice(0, 8) + "…" + value.slice(-4);
    }

    function railLabel(rail) {
      return rail === "circle-gateway-batched" ? "Gateway nanopayment" : "Direct USDC";
    }

    let limit = 100;

    async function load(event) {
      if (event) event.preventDefault();
      const token = tokenInput.value.trim();
      sessionStorage.setItem("verity-portal-token", token);
      const headers = { authorization: "Bearer " + token };
      const [activityRes, purchasesRes] = await Promise.all([
        fetch("/activity?limit=" + limit, { headers }),
        fetch("/purchases", { headers }),
      ]);
      if (!activityRes.ok || !purchasesRes.ok) {
        message.textContent = "Portal refused the read token.";
        return;
      }
      const activity = await activityRes.json();
      const purchases = await purchasesRes.json();
      message.textContent = "Showing " + activity.logs.length + " of " + activity.observations + " USDC logs · chain head " + activity.head;
      document.querySelector("#logs").innerHTML = activity.logs.map((row) =>
        "<tr><td>" + escapeHtml(row.blockNumber) + "</td><td>" + txLink(row.txHash) + "</td><td>" +
        (row.kind === "authorization" ? "Authorization" : "Transfer") + "</td><td class='muted'>" + escapeHtml(short(row.from)) +
        "</td><td class='muted'>" + escapeHtml(short(row.to)) + "</td><td>" + escapeHtml(row.amountBaseUnits ?? "") +
        "</td><td class='muted'>" + escapeHtml(row.nonce ? short(row.nonce) : "") + "</td></tr>"
      ).join("");
      document.querySelector("#rows").innerHTML = purchases.purchases.map((row) =>
        "<tr><td>" + escapeHtml(row.purchaseId) + "<div class='muted'>" + escapeHtml(row.merchantLabel) + "</div></td>" +
        "<td>" + escapeHtml(railLabel(row.rail)) + "</td>" +
        "<td>" + escapeHtml(row.ledgerStatus) + "<div class='muted'>" + escapeHtml(row.detail) + "</div></td>" +
        "<td>" + escapeHtml(row.amountBaseUnits) + "</td>" +
        "<td>" + (row.quicknode === "not_claimed" ? "not claimed" : txLink(row.txHash) || escapeHtml(row.quicknode)) + "</td></tr>"
      ).join("");
      document.querySelector("#more").hidden = activity.logs.length >= activity.observations;
    }

    document.querySelector("#auth").addEventListener("submit", load);
    document.querySelector("#more").addEventListener("click", () => { limit = Math.min(500, limit + 100); load(); });
    if (stored) load();
    setInterval(() => { if (sessionStorage.getItem("verity-portal-token")) load(); }, 4000);
  </script>
</body>
</html>`;
}

export function publicPurchase(purchase: PortalPurchase) {
  return purchase;
}

export function publicUnmatched(payment: UnmatchedObservation) {
  return payment;
}
