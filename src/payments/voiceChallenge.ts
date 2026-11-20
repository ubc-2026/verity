import { createHmac } from "node:crypto";

/**
 * Registers a one-time-code challenge with the voice-verify Worker before the approval call. Only an HMAC of the code
 * is sent, so the Worker never sees the code. The ElevenLabs agent then asks the Worker to check what the person says
 * while they are still on the line. See voice-verify/worker.mjs.
 */
export interface VoiceChallengeConfig {
  baseUrl: string;
  adminSecret: string;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

export function codeMac(adminSecret: string, purchaseId: string, code: string): string {
  return createHmac("sha256", adminSecret).update(`${purchaseId}:${code}`).digest("hex");
}

export class VoiceChallengeClient {
  readonly #config: VoiceChallengeConfig;
  readonly #fetch: Fetch;

  constructor(options: { config: VoiceChallengeConfig; fetch?: Fetch }) {
    this.#config = options.config;
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as Fetch);
  }

  /** Throws if the challenge could not be registered. The caller must not place the call in that case. */
  async register(info: { purchaseId: string; code: string }): Promise<void> {
    const response = await this.#fetch(`${this.#config.baseUrl.replace(/\/$/, "")}/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-voice-admin-secret": this.#config.adminSecret },
      body: JSON.stringify({ purchase_id: info.purchaseId, code_mac: codeMac(this.#config.adminSecret, info.purchaseId, info.code) }),
    });
    if (!response.ok) throw new Error(`voice-verify rejected the challenge (HTTP ${response.status})`);
  }
}

export function voiceChallengeFromEnv(env: Record<string, string | undefined>): VoiceChallengeClient | undefined {
  const baseUrl = env.VOICE_VERIFY_URL;
  const adminSecret = env.VOICE_ADMIN_SECRET;
  return baseUrl && adminSecret ? new VoiceChallengeClient({ config: { baseUrl, adminSecret } }) : undefined;
}
