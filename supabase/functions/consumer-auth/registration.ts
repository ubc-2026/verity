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

// See supabase/consumer-auth-github-signup.sql. A proof stays for 10 minutes, longer than the 2-minute ticket,
// so a ticket that was already used is still on record and cannot be used again.
export function githubRegistration(dbUrl: string): ConsumerAuthConfig["githubSignup"] {
  if (!dbUrl) return;
  const sql = postgres(dbUrl, { ssl: "verify-full", max: 1, prepare: false, fetch_types: false, connect_timeout: 4, idle_timeout: 10 });

  return {
    async allowSignup(ticketId, clientIp) {
      return await sql.begin(async (tx) => {
        await tx`DELETE FROM app_private.github_signup_proofs WHERE expires_at <= statement_timestamp()`;
        const rows = await tx`
          INSERT INTO app_private.github_signup_proofs (ticket_hash, ip_hash, expires_at)
          SELECT sha256(convert_to(${ticketId}, 'UTF8')), hash, statement_timestamp() + interval '10 minutes'
          FROM (SELECT app_private.signup_address_hash(${clientIp}) AS hash) AS address
          WHERE hash IS NOT NULL
          ON CONFLICT (ticket_hash) DO NOTHING
          RETURNING 1
        `;
        return rows.length === 1;
      });
    },
    // The row stays until it expires, so the same ticket still cannot record a second proof.
    async closeProof(ticketId) {
      await sql`
        UPDATE app_private.github_signup_proofs SET consumed_at = statement_timestamp()
        WHERE ticket_hash = sha256(convert_to(${ticketId}, 'UTF8')) AND consumed_at IS NULL
      `;
    },
  };
}
