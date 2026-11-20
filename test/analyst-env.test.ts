import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pythonChildEnv } from "../src/app/analyst.ts";

describe("analysis child environment", () => {
  it("passes an allowlist only, and always sets the Python encoding flags", () => {
    const env = pythonChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/analyst",
      LANG: "C.UTF-8",
      VERITY_OPERATOR_TOKEN: "secret-token",
      ELEVENLABS_API_KEY: "eleven",
      PYTHONIOENCODING: "latin1",
    });
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/home/analyst");
    assert.equal(env.LANG, "C.UTF-8");
    assert.equal(env.PYTHONIOENCODING, "utf-8");
    assert.equal(env.PYTHONUTF8, "1");
    assert.equal(env.VERITY_OPERATOR_TOKEN, undefined);
    assert.equal(env.ELEVENLABS_API_KEY, undefined);
    assert.equal("PYTHONIOENCODING" in env, true);
    assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH", "PYTHONIOENCODING", "PYTHONUTF8"]);
  });
});
