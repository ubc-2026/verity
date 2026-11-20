/**
 * The research store suite on a real Postgres server. Runs only when
 * VERITY_RESEARCH_TEST_PG_URL names an admin connection to a disposable local
 * server, for example:
 *   docker run --rm -d --name verity-research-pg -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=... postgres:17-alpine
 * Each run creates and drops its own database. Never point it at a shared one.
 */
import { randomBytes } from "node:crypto";
import { openPostgres } from "../src/research/sql.ts";
import { researchSuite } from "./research.shared.ts";

const admin = process.env.VERITY_RESEARCH_TEST_PG_URL;
const local = admin ? ["127.0.0.1", "localhost", "::1"].includes(new URL(admin).hostname) : false;

researchSuite(
  "Postgres server",
  async () => {
    const root = await openPostgres(admin!, "verity-research-test");
    const name = `verity_research_test_${randomBytes(4).toString("hex")}`;
    await root.exec(`create database ${name}`);
    const u = new URL(admin!);
    u.pathname = `/${name}`;
    const owner = await openPostgres(u.toString(), "verity-research-test");
    return {
      owner,
      close: async () => {
        await owner.close();
        await root.exec(`drop database if exists ${name} with (force)`);
        await root.close();
      },
    };
  },
  !admin ? "set VERITY_RESEARCH_TEST_PG_URL to a disposable local Postgres" : !local ? "VERITY_RESEARCH_TEST_PG_URL must point at localhost" : false,
);
