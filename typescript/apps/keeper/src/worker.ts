// The deployed Keeper: one Durable Object, `Keeper` named "keeper", whose
// alarm runs one pass every POLL_INTERVAL_MS (keeper.ts). Only one alarm runs
// at a time per Durable Object, so this Keeper's passes never overlap.
//
// A cron trigger every minute calls `start`, which sets the alarm if none is
// set: it starts the loop after the first deploy and restarts it if the
// alarm was ever lost. The Resolver's attempts live in the Durable Object's
// SQLite storage, by oracle and Assertion id, so restarts and deploys don't
// resolve an Assertion twice. An Assertion given up on after failed tries is
// tried again once GIVE_UP_RETRY_MS has passed, in case the failure was an outage.

import type { ResolverAttempt, ResolverMemory } from "@enzure/core";
import { DurableObject } from "cloudflare:workers";
import { loadConfig, type KeeperConfig } from "./config.ts";
import { createKeeper, jsonLog as log, type Keeper as KeeperPass } from "./keeper.ts";

/** The one Keeper. A second name would run a second Keeper with the same keys. */
const KEEPER_NAME = "keeper";

/** How long a given-up Assertion waits before the Resolver tries it again. */
const GIVE_UP_RETRY_MS = 30 * 60_000;

export class Keeper extends DurableObject<Env> {
  #keeper: { config: KeeperConfig; keeper: KeeperPass } | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keyed by oracle too: every oracle numbers its Assertions from 1, and this
    // storage outlives a change of ORACLE_ACCOUNT_ID.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS resolver_attempts (
      oracle TEXT NOT NULL,
      assertion_id INTEGER NOT NULL,
      tries INTEGER NOT NULL,
      done INTEGER NOT NULL,
      gave_up_at INTEGER,
      PRIMARY KEY (oracle, assertion_id)
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
      const keeper = createKeeper(config, {
        resolverMemory: this.#resolverMemory(config.oracleAccountId),
      });
      log(keeper.describe());
      this.#keeper = { config, keeper };
    }
    return this.#keeper;
  }

  #resolverMemory(oracle: string): ResolverMemory {
    const sql = this.ctx.storage.sql;
    return {
      get(assertionId) {
        const [row] = sql
          .exec<{ tries: number; done: number; gave_up_at: number | null }>(
            "SELECT tries, done, gave_up_at FROM resolver_attempts WHERE oracle = ? AND assertion_id = ?",
            oracle,
            assertionId,
          )
          .toArray();
        if (row === undefined) return undefined;
        if (row.gave_up_at !== null && Date.now() - row.gave_up_at >= GIVE_UP_RETRY_MS) {
          log({ event: "resolver_retrying", assertionId, oracle });
          return undefined; // start again with a fresh set of tries
        }
        return { tries: row.tries, done: row.done === 1 };
      },
      set(assertionId, { tries, done, gaveUp }: ResolverAttempt) {
        sql.exec(
          `INSERT INTO resolver_attempts (oracle, assertion_id, tries, done, gave_up_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (oracle, assertion_id) DO UPDATE SET
             tries = excluded.tries, done = excluded.done, gave_up_at = excluded.gave_up_at`,
          oracle,
          assertionId,
          tries,
          done ? 1 : 0,
          gaveUp ? Date.now() : null,
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
