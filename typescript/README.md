# TypeScript workspace

One Vite+ monorepo using pnpm (ADR 0005).

- `packages/core`: business logic as composable functions, with no knowledge of how they are deployed.
- `apps/`: deployed apps only. Each app owns its auth, Zod validation, HTTP routes, configuration and secrets, and wires `core` together.
  - `apps/storage`: the storage service for Claims and Evidence, at https://enzure-storage.luckzivanius.workers.dev.

Example code, scripts and fixtures live in the repository root, not here.

```bash
vp install        # install dependencies
vp check          # format, lint and type checks
vp test           # run all tests
vp run ready      # check, test and build every package
```
