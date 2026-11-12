## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `0verlabs/enzure` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Repository layout and stack

Read `docs/adr/0005-hybrid-monorepo-layout-and-stack.md` before adding code or dependencies. Don't pick a different stack or put code outside these places without asking:

- `contracts/<chain>/`: production contracts only.
- `typescript/`: one Vite+ monorepo with pnpm. Business logic goes in `typescript/packages/core`; deployed apps go in `typescript/apps/` and own their auth, validation, routes and config.
- `examples/`: example and demo code. `scripts/`: test and operations scripts. `fixtures/`: shared real signed test data.
- Deploy to Cloudflare; long-lived processes go to Render.
