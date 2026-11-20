import { createRemoteJWKSet, jwtVerify } from "npm:jose@6.2.12";
import postgres from "npm:postgres@4.1.1";
import type { ConsumerAuthConfig } from "./handler.ts";

export function googleRegistration(clientId: string, dbUrl: string): ConsumerAuthConfig["registration"] {
  if (!/^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/.test(clientId) || !dbUrl) return;

  const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), { timeoutDuration: 5000 });
  // This uses the existing Supabase function-to-database connection. No database
  // credentials or OAuth tokens are sent to the browser.
  const sql = postgres(dbUrl, { ssl: "verify-full", max: 1, prepare: false, fetch_types: false, connect_timeout: 4, idle_timeout: 10 });

  return {
    clientId,
    async verifyIdentity(credential, nonce) {
      try {
        const { payload } = await jwtVerify(credential, googleKeys, {
          issuer: ["https://accounts.google.com", "accounts.google.com"],
          audience: clientId,
          algorithms: ["RS256"],
          requiredClaims: ["exp", "iat", "sub", "nonce"],
          maxTokenAge: "5 minutes",
          clockTolerance: 10,
        });
        if (payload.nonce !== nonce || payload.aud !== clientId || (payload.azp && payload.azp !== clientId) ||
            payload.email_verified !== true || !payload.sub || !/^[A-Za-z0-9_-]{1,255}$/.test(payload.sub)) return;
        return payload.sub;
      } catch {
        return;
      }
    },
    async allowSignup(subject) {
      await sql.begin(async (tx) => {
        await tx`DELETE FROM app_private.google_signup_proofs WHERE expires_at <= statement_timestamp()`;
        await tx`
          INSERT INTO app_private.google_signup_proofs (subject_hash, expires_at)
          VALUES (sha256(convert_to(${subject}, 'UTF8')), statement_timestamp() + interval '45 seconds')
          ON CONFLICT (subject_hash) DO UPDATE SET expires_at = excluded.expires_at
        `;
      });
    },
  };
}
