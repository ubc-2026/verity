/**
 * QuickNode Streams filter for Arc Testnet USDC settlements.
 *
 * Dataset: block_with_receipts
 * Network: Arc Testnet (chain ID 5042002)
 * Destination: POST https://<host>/webhooks/quicknode
 *
 * Every block header is forwarded so finality can advance. Receipts are
 * reduced to USDC Transfer and AuthorizationUsed logs. Reorg metadata is
 * passed through so the ledger can drop displaced blocks.
 *
 * Topic constants are checked against src/chain.ts in test/filter.test.ts.
 */
function main(stream) {
  const USDC = "0x3600000000000000000000000000000000000000";
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const AUTHORIZATION_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

  const blocks = [];
  for (const entry of stream.data || []) {
    const block = entry.block || {};
    const receipts = [];
    for (const receipt of entry.receipts || []) {
      const logs = (receipt.logs || []).filter((log) => {
        const address = String(log.address || "").toLowerCase();
        const topic = log.topics && log.topics[0];
        return address === USDC && (topic === TRANSFER || topic === AUTHORIZATION_USED);
      });
      if (logs.length === 0) continue;
      receipts.push({
        transactionHash: receipt.transactionHash,
        status: receipt.status,
        logs: logs.map((log) => ({
          address: log.address,
          topics: log.topics,
          data: log.data,
          logIndex: log.logIndex,
          removed: log.removed,
        })),
      });
    }
    blocks.push({
      block: {
        number: block.number,
        hash: block.hash,
        parentHash: block.parentHash,
      },
      receipts,
    });
  }

  const metadata = stream.metadata || {};
  const reorgs = []
    .concat(metadata.blocks_reorged || [])
    .concat(metadata.reorgs || []);
  if (blocks.length === 0 && reorgs.length === 0) return null;
  return { data: blocks, metadata };
}
