import { validInstrument } from "./public-history.mjs";

const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sourceModes = new Set(["live", "captured", "fixture"]);

function requireUuid(value) {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new TypeError("Invalid UUID");
}

// Call only from trusted server code. accountId comes from the verified Supabase
// Auth session. A request body, URL, or unverified token cannot supply this ID.
export function privateResearchRuns(sql, accountId) {
  requireUuid(accountId);

  function withAccount(operation) {
    return sql.begin(async (tx) => {
      await tx`SELECT set_config('verity.account_id', ${accountId}, true)`;
      return operation(tx);
    });
  }

  return {
    save({ id, instrument, sourceMode, report }) {
      requireUuid(id);
      if (!validInstrument(instrument) || !sourceModes.has(sourceMode) || !report ||
          Object.getPrototypeOf(report) !== Object.prototype) throw new TypeError("Invalid research run");
      const payload = JSON.stringify(report);
      if (new TextEncoder().encode(payload).byteLength > 32_768) throw new TypeError("Research report is too large");

      return withAccount(async (tx) => {
        await tx`
          INSERT INTO app_private.research_runs (owner_id, id, instrument, source_mode, report)
          VALUES (${accountId}::uuid, ${id}::uuid, ${instrument}, ${sourceMode}, ${payload}::jsonb)
          ON CONFLICT (owner_id, id) DO NOTHING
        `;
        const [run] = await tx`
          SELECT id, instrument, source_mode AS "sourceMode", report, completed_at AS "completedAt"
          FROM app_private.research_runs
          WHERE owner_id = ${accountId}::uuid AND id = ${id}::uuid
            AND instrument = ${instrument} AND source_mode = ${sourceMode} AND report = ${payload}::jsonb
        `;
        if (!run) throw new Error("Research run ID already used for different content");
        return run;
      });
    },

    list() {
      return withAccount((tx) => tx`
        SELECT id, instrument, source_mode AS "sourceMode", report, completed_at AS "completedAt"
        FROM app_private.research_runs WHERE owner_id = ${accountId}::uuid
        ORDER BY completed_at DESC, id DESC LIMIT 50
      `);
    },
  };
}
