# Scripts

Scripts run by hand for testing and operations, such as deploys, DAO setup and checks against live services (ADR 0005).

- `test.sh`: runs the NEAR sandbox tests, the Foundry tests and the Vite+ checks and tests. Run it from anywhere: `./scripts/test.sh`.
- `check-near-ai-signing.mts`: sends one AI Verdict request to NEAR AI Cloud and checks that the response carries a `provider_tee` ed25519 signature over the exact request and response bytes, from the key in the model's attestation report. It needs `NEARAI_API_KEY` and costs well under $0.001 per run. Run it from the repository root:

  ```bash
  node --env-file-if-exists=.env scripts/check-near-ai-signing.mts                  # check Prompt Template v1's model
  node --env-file-if-exists=.env scripts/check-near-ai-signing.mts --model <id>     # try another model with the same settings
  node --env-file-if-exists=.env scripts/check-near-ai-signing.mts --write-fixture  # also replace fixtures/near-ai-cloud/signed-response.json
  ```

  It exits non-zero if any check fails. Results are in `docs/research/near-ai-cloud.md` §7.
