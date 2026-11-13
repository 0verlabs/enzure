// The deployed Keeper: one Durable Object, `Keeper` named "keeper", whose
// alarm runs one pass every POLL_INTERVAL_MS (keeper.ts). Only one alarm runs
// at a time per Durable Object, so passes never overlap and the NEAR and EVM
// accounts never send two transactions at once.
//
// A cron trigger every minute calls `start`, which sets the alarm if none is
// set: it starts the loop after the first deploy and restarts it if the
// alarm was ever lost. The Resolver's attempts live in the Durable Object's
// SQLite storage, so restarts and deploys don't resolve an Assertion twice.

import type { ResolverAttempt, ResolverMemory } from "@enzure/core";
import { DurableObject } from "cloudflare:workers";
import { loadConfig, type KeeperConfig } from "./config.ts";
import { createKeeper, jsonLog as log, type Keeper as KeeperPass } from "./keeper.ts";

/** The one Keeper. A second name would run a second Keeper with the same keys. */
const KEEPER_NAME = "keeper";

export class Keeper extends DurableObject<Env> {
  #keeper: { config: KeeperConfig; keeper: KeeperPass } | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS resolver_attempts (
      assertion_id INTEGER PRIMARY KEY,
      tries INTEGER NOT NULL,
      done INTEGER NOT NULL
    )`);
  }

  /**
   * Sets the alarm if none is set, so the loop runs. During a pass `getAlarm`
   * is null; the alarm set here is then replaced when the pass sets its next one.
   */
  async start(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  override async alarm(): Promise<void> {
    const started = Date.now();
    let interval = 60_000; // until the configuration loads
    try {
      const { config, keeper } = this.#load();
      interval = config.pollIntervalMs;
      await keeper.pass();
    } catch (error) {
      log({ event: "pass_failed", error: String(error) });
    } finally {
      // Always set the next alarm: alarms are retried only six times after a throw.
      await this.ctx.storage.setAlarm(started + interval);
    }
  }

  /** The configuration and Keeper, made on the first pass after the object starts. */
  #load() {
    if (this.#keeper === undefined) {
      const config = loadConfig({ ...this.env });
      const keeper = createKeeper(config, { resolverMemory: this.#resolverMemory() });
      log(keeper.describe());
      this.#keeper = { config, keeper };
    }
    return this.#keeper;
  }

  #resolverMemory(): ResolverMemory {
    const sql = this.ctx.storage.sql;
    return {
      get(assertionId) {
        const [row] = sql
          .exec<{ tries: number; done: number }>(
            "SELECT tries, done FROM resolver_attempts WHERE assertion_id = ?",
            assertionId,
          )
          .toArray();
        return row === undefined ? undefined : { tries: row.tries, done: row.done === 1 };
      },
      set(assertionId, { tries, done }: ResolverAttempt) {
        sql.exec(
          `INSERT INTO resolver_attempts (assertion_id, tries, done) VALUES (?, ?, ?)
           ON CONFLICT (assertion_id) DO UPDATE SET tries = excluded.tries, done = excluded.done`,
          assertionId,
          tries,
          done ? 1 : 0,
        );
      },
    };
  }
}

export default {
  // There is no HTTP API; the dev server needs a fetch handler to start.
  fetch() {
    return new Response("The Keeper has no HTTP API.\n", { status: 404 });
  },
  async scheduled(_controller, _env, ctx) {
    await ctx.exports.Keeper.getByName(KEEPER_NAME).start();
  },
} satisfies ExportedHandler<Env>;
