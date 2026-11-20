import { createResearchWorker } from "../../research-worker.mjs";

const stored = createResearchWorker(async () => [{
  observedAtUtc: "2026-11-20T02:15:46.000Z",
  timeBasis: "collector",
  bestBid: "0.83",
  bestAsk: "0.97",
  marketState: "open",
}]);

export default {
  fetch(request) {
    return stored.fetch(request, { VERITY_HISTORY_DB: { connectionString: "test-only" } });
  },
};
