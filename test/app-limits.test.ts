import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Analyst, findPython, LiveAnalysisBusyError, MAX_LIVE_IN_FLIGHT } from "../src/app/analyst.ts";

// A stand-in `verity.cli` that takes a moment, so live analyses overlap. Nothing leaves the machine.
describe("live analysis concurrency", () => {
  let dir: string;
  let python: string;
  before(() => {
    python = findPython(join(import.meta.dirname, "..", "analysis"));
    dir = mkdtempSync(join(tmpdir(), "verity-live-cap-"));
    mkdirSync(join(dir, "verity"));
    writeFileSync(join(dir, "verity", "__init__.py"), "");
    writeFileSync(join(dir, "verity", "cli.py"), "import time\ntime.sleep(1.5)\nprint('{}')\n");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it(`runs at most ${MAX_LIVE_IN_FLIGHT} uncached live analyses at once and frees the slots when they finish`, async () => {
    const analyst = new Analyst(python, dir);
    const running = Array.from({ length: MAX_LIVE_IN_FLIGHT }, (_, i) => analyst.analyzeLive(`EVT-${i}`, "x").catch(() => "done"));
    await assert.rejects(analyst.analyzeLive("EVT-busy", "x"), LiveAnalysisBusyError);
    // A cached key does not take a slot.
    const again = analyst.analyzeLive("EVT-0", "x").catch(() => "done");
    await Promise.all([...running, again]);
    const next = analyst.analyzeLive("EVT-next", "x").then(() => "ok", (error: unknown) => error);
    assert.ok(!((await next) instanceof LiveAnalysisBusyError), "a slot is free again after the earlier runs finish");
  });
});
