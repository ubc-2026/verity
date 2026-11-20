import { createConsumerAuth } from "./handler.ts";
import { googleRegistration } from "./registration.ts";

Deno.serve(createConsumerAuth({
  siteOrigin: Deno.env.get("VERITY_AUTH_SITE_ORIGIN") ?? "",
  projectUrl: Deno.env.get("SUPABASE_URL") ?? "",
  publishableKey: Deno.env.get("VERITY_AUTH_PUBLISHABLE_KEY") ?? "",
  edgeKey: Deno.env.get("VERITY_AUTH_EDGE_KEY") ?? "",
  cookieKey: Deno.env.get("VERITY_AUTH_COOKIE_KEY") ?? "",
  turnstileSecret: Deno.env.get("VERITY_AUTH_TURNSTILE_SECRET") ?? "",
  registration: googleRegistration(
    Deno.env.get("VERITY_AUTH_GOOGLE_CLIENT_ID") ?? "",
    Deno.env.get("SUPABASE_DB_URL") ?? "",
  ),
}));
