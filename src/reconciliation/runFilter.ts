import { runInNewContext } from "node:vm";
import { filterSource } from "./streamConfig.ts";

/**
 * Runs the Streams filter locally in an isolated context, the way the
 * QuickNode sandbox calls `main(stream)`. Used for tests and local replays.
 */
export function runStreamFilter(stream: { data: unknown; metadata?: unknown }, targetTxHashes: string[] = []): unknown {
  const context: { stream: unknown; result?: unknown } = { stream: JSON.parse(JSON.stringify(stream)) };
  runInNewContext(`${filterSource(targetTxHashes)}\nresult = main(stream);`, context, { timeout: 1000 });
  // JSON round-trip: the delivered body is JSON, and it leaves the sandbox realm.
  return context.result == null ? null : JSON.parse(JSON.stringify(context.result));
}
