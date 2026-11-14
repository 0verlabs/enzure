# Repository layout


The layout follows [ADR 0005](adr/0005-hybrid-monorepo-layout-and-stack.md): contracts by chain, one TypeScript workspace with the business logic in `core`, and everything that doesn't ship kept outside both.

| Path | What it holds | Runs on |
| --- | --- | --- |
| `contracts/near/oracle/` | The oracle contract (Rust, near-sdk 5.30.1, cargo-near) and its sandbox tests. Test-only contracts (mock Chain Signatures signer, test Consumers) are in `oracle/tests/contracts/`. | NEAR testnet |
| `contracts/evm/` | The Receiver and the `IEnzureConsumer` interface (Solidity 0.8.30, Foundry), with tests and a deploy script. | Any EVM chain; Base Sepolia planned |
| `typescript/packages/core/` | Business logic as functions: building the AI request, checking signatures, encoding the result message, deciding which calls are due, reading oracle state, the Resolver and Relayer. | Library |
| `typescript/apps/storage/` | Storage service: Hono with Zod on a Cloudflare Worker with R2. | Cloudflare (deployed) |
| `typescript/apps/web/` | Web app: TanStack Start with Tailwind and shadcn/ui, NEAR wallet connection. | Cloudflare (not deployed) |
| `typescript/apps/keeper/` | Keeper: Resolver, Scheduler and a Relayer per chain, run by a Durable Object alarm, with near-kit and viem. | Cloudflare (not deployed) |
| `examples/escrow/` | The escrow demo: escrow and test USDC (Foundry), buyer script, seller agent, `demo.sh`. | Base Sepolia (planned), local |
| `examples/near-consumer/`, `examples/evm-consumer/` | Minimal Consumers for NEAR Hooks and EVM Hooks. | |
| `scripts/` | Test, deploy, DAO and check scripts. `scripts/test.sh` runs every suite. | Your machine |
| `fixtures/` | Real signed data shared by the Rust, Solidity and TypeScript tests. | |
| `docs/` | ADRs, research and the toolchain. `GLOSSARY.md` defines the terms. | |
