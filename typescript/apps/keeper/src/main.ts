// The Keeper as a local Node process: one pass every POLL_INTERVAL_MS until
// SIGINT or SIGTERM. For development and the testnet scripts
// (scripts/keeper-dispute.sh, examples/escrow/demo.sh); the deployed Keeper is
// the Worker in worker.ts. The Resolver's memory lasts as long as the process.

import { loadConfig, type KeeperConfig } from "./config.ts";
import { createKeeper, jsonLog as log } from "./keeper.ts";

let config: KeeperConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const keeper = createKeeper(config);

let stopping = false;
let wake: (() => void) | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log({ event: "stopping", signal });
    stopping = true;
    wake?.();
  });
}

log(keeper.describe());
while (!stopping) {
  const started = Date.now();
  try {
    await keeper.pass();
  } catch (error) {
    log({ event: "pass_failed", error: String(error) });
  }
  const wait = Math.max(0, config.pollIntervalMs - (Date.now() - started));
  await new Promise<void>((resolve) => {
    wake = resolve;
    setTimeout(resolve, wait);
  });
}
log({ event: "stopped" });
