import type { Hex } from "viem";
import { parseStreamPayload } from "./parse.ts";

export interface PortalObservation {
  txHash: string;
  blockNumber: number;
  blockHash: string;
  kind: "transfer" | "authorization";
  payer: string;
  payTo: string | null;
  amountBaseUnits: string;
  nonce: string | null;
  logIndex: number;
  source: "quicknode";
}

/** One row per USDC log QuickNode delivered: transfers and AuthorizationUsed tickets. */
export function observationsFromStream(body: unknown, token: Hex): { head: number; observations: PortalObservation[] } {
  const batch = parseStreamPayload(body, token);
  let head = 0;
  const observations: PortalObservation[] = [];
  for (const block of batch.blocks) {
    head = Math.max(head, block.number);
    for (const tx of block.txs) {
      for (const transfer of tx.transfers) {
        observations.push({
          txHash: tx.txHash,
          blockNumber: tx.blockNumber,
          blockHash: tx.blockHash,
          kind: "transfer",
          payer: transfer.from,
          payTo: transfer.to,
          amountBaseUnits: transfer.value,
          nonce: null,
          logIndex: transfer.logIndex,
          source: "quicknode",
        });
      }
      for (const auth of tx.auths) {
        observations.push({
          txHash: tx.txHash,
          blockNumber: tx.blockNumber,
          blockHash: tx.blockHash,
          kind: "authorization",
          payer: auth.authorizer,
          payTo: null,
          amountBaseUnits: "0",
          nonce: auth.nonce,
          logIndex: auth.logIndex,
          source: "quicknode",
        });
      }
    }
  }
  return { head, observations };
}

export async function reportStream(url: string, writeToken: string, body: unknown, token: Hex): Promise<void> {
  const report = observationsFromStream(body, token);
  if (report.head === 0 && report.observations.length === 0) return;
  const response = await fetch(new URL("/observations", url), {
    method: "POST",
    headers: { authorization: `Bearer ${writeToken}`, "content-type": "application/json" },
    body: JSON.stringify(report),
  });
  if (!response.ok) throw new Error(`portal responded ${response.status}`);
}
