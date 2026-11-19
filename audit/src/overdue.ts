import type { Hex } from "viem";

export interface OverdueEvent {
  schema: "verity.overdue_delivery.v1";
  eventId: string;
  environment: "fixture" | "arc-testnet";
  purchaseId: string;
  exceptionType: "paid_delivery_missing";
  ledgerStatus: "Paid, delivery missing";
  settlementConfirmed: true;
  txHash: Hex;
  amountBaseUnits: string;
  merchantLabel: string;
  deliveryDeadlineUtc: string;
  emittedAtUtc: string;
}

export function overdueEvent(input: {
  environment: "fixture" | "arc-testnet";
  purchaseId: string;
  txHash: Hex;
  amountBaseUnits: string;
  merchantLabel: string;
  deliveryDeadlineUtc: string;
  emittedAt: Date;
}): OverdueEvent {
  const emittedAtUtc = input.emittedAt.toISOString();
  return {
    schema: "verity.overdue_delivery.v1",
    eventId: `evt-${input.purchaseId}-${emittedAtUtc}`,
    environment: input.environment,
    purchaseId: input.purchaseId,
    exceptionType: "paid_delivery_missing",
    ledgerStatus: "Paid, delivery missing",
    settlementConfirmed: true,
    txHash: input.txHash,
    amountBaseUnits: input.amountBaseUnits,
    merchantLabel: input.merchantLabel,
    deliveryDeadlineUtc: input.deliveryDeadlineUtc,
    emittedAtUtc,
  };
}

/** POST one event until the routine returns 200. Retries are safe; the incident key dedupes cards. */
export async function postOverdueEvent(
  event: OverdueEvent,
  options: { url: string; key: string; fetchImpl?: typeof fetch; attempts?: number; sleep?: (ms: number) => Promise<void> },
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = options.attempts ?? 5;
  let delay = 200;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchImpl(options.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    });
    if (response.status === 200) return;
    lastStatus = response.status;
    if (attempt < attempts) {
      await sleep(delay);
      delay *= 2;
    }
  }
  throw new Error(`overdue webhook returned ${lastStatus}`);
}
