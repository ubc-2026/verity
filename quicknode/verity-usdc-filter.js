// Verity: Arc Testnet USDC EIP-3009 settlement filter for QuickNode Streams.
// Dataset: block_with_receipts. Runs in the Streams JavaScript sandbox, so it
// uses plain ES5-style code with no imports. Keeps successful receipts that
// emitted USDC AuthorizationUsed, plus their USDC Transfer logs. Also keeps
// successful receipts sent to the Circle GatewayWallet as gatewayBatches: QuickNode
// confirms the batch transaction; Circle's transfer record links one payment to it.
var USDC = "0x3600000000000000000000000000000000000000";
var GATEWAY_WALLET = "0x0077777d7eba4688bdef3e311b846f25870a19b9";
var AUTHORIZATION_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
var TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// Lowercase transaction hashes. Empty keeps every matching receipt.
var TARGET_TX_HASHES = [];

function main(stream) {
  var entries = Array.isArray(stream.data) ? stream.data : [stream.data];
  var matches = [];
  var gatewayBatches = [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i] || {};
    var block = entry.block || {};
    var receipts = entry.receipts || [];
    for (var j = 0; j < receipts.length; j++) {
      var receipt = receipts[j];
      var txHash = String(receipt.transactionHash || "").toLowerCase();
      if (TARGET_TX_HASHES.length > 0 && TARGET_TX_HASHES.indexOf(txHash) < 0) continue;
      if (String(receipt.to || "").toLowerCase() === GATEWAY_WALLET && receipt.status === "0x1") {
        gatewayBatches.push({
          blockNumber: block.number,
          blockHash: block.hash,
          blockTimestamp: block.timestamp,
          transactionHash: receipt.transactionHash,
          to: receipt.to,
          status: receipt.status,
          logCount: (receipt.logs || []).length,
        });
      }
      var logs = [];
      var hasAuthorization = false;
      var receiptLogs = receipt.logs || [];
      for (var k = 0; k < receiptLogs.length; k++) {
        var log = receiptLogs[k];
        var topic0 = log.topics && log.topics[0];
        if (String(log.address).toLowerCase() !== USDC) continue;
        if (topic0 !== AUTHORIZATION_USED && topic0 !== TRANSFER) continue;
        if (topic0 === AUTHORIZATION_USED) hasAuthorization = true;
        logs.push({ address: log.address, topics: log.topics, data: log.data, logIndex: log.logIndex });
      }
      if (!hasAuthorization) continue;
      matches.push({
        blockNumber: block.number,
        blockHash: block.hash,
        blockTimestamp: block.timestamp,
        transactionHash: receipt.transactionHash,
        transactionIndex: receipt.transactionIndex,
        from: receipt.from,
        to: receipt.to,
        status: receipt.status,
        logs: logs,
      });
    }
  }
  if (matches.length === 0 && gatewayBatches.length === 0) return null;
  return { verity: "arc-usdc-eip3009-v1", metadata: stream.metadata || null, matches: matches, gatewayBatches: gatewayBatches };
}
