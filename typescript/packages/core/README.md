# @enzure/core

Enzure's business logic as composable functions, with no knowledge of how they are deployed. Apps in `typescript/apps/` own auth, Zod validation, HTTP routes, configuration and secrets, and wire core together (ADR 0005).

```bash
vp test   # run the tests
vp pack   # build to dist/
```
