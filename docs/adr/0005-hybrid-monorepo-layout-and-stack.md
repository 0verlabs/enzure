# Hybrid monorepo: contracts by chain, one TypeScript workspace, business logic in core

The repository holds contracts in several languages and a set of TypeScript apps, so it is split by toolchain rather than forced into one. Each folder has one job:

- `contracts/<chain>/` holds production contracts only, one project per chain (Rust with near-sdk and cargo-near for NEAR, Foundry for EVM). A folder for another chain is added only when that chain is in scope.
- `typescript/` is one Vite+ monorepo using pnpm. `typescript/packages/core` holds the business logic as composable functions with no knowledge of how they are deployed. `typescript/apps/` holds deployed apps, and each app owns its auth, Zod validation, HTTP routes, configuration and secrets, and wires `core` together.
- `examples/` holds example and demo code, including example Consumers and the escrow demo with its seller agent.
- `scripts/` holds scripts run by hand for testing and operations, such as deploys, DAO setup and checks against live services.
- `fixtures/` holds real signed artefacts shared by the Rust, Solidity and TypeScript tests.
- Test-only contracts, such as a mock Chain Signatures signer, live in the test folder of the project that uses them, not as packages of their own.

Stack: TanStack Start with Tailwind and shadcn for the web app, Hono for HTTP APIs, Zod for validation, and Cloudflare (Workers, Durable Objects, D1, KV, R2, with Drizzle on D1) for deployments. Long-lived processes, which Cloudflare's request and alarm model fits poorly, run on Render instead. (Superseded for the Keeper by ADR 0006: the Resolver, Scheduler and Relayer run on a Durable Object alarm on Cloudflare.) We rejected one flat package per module under `typescript/packages/`, because it spreads one domain across many small packages, and putting examples or test helpers inside `contracts/` or `typescript/`, because it mixes code that ships with code that doesn't.
