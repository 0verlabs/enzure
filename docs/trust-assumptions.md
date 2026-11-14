# Trust assumptions and known gaps

## Trust assumptions

- **The DAO council decides Appeals and Registered Keys.** It also sets the timers and bonds, publishes Prompt Templates and can upgrade the contract. In the demo the council is two accounts and one vote passes, so whoever holds either key controls the oracle.
- **A TEE signature proves which model produced which response to which request. It does not prove the answer is right.** The model can be wrong or be talked round by text in the Claim or Evidence; the prompt marks both as data, which reduces prompt injection but doesn't stop it. Bonds and the Appeal are the defence.
- **A TEE signature doesn't prove the software inside the TEE was uncompromised.** NEAR AI's own [security incident report](https://near.ai/blog/security-incident-report-sglang-vulnerability) (November 2026) says an attacker exploited a remote code execution vulnerability in SGLang, the open-source inference engine running on its servers, which gave them code execution on one inference server. On November 8, it says, they could also have observed user requests being processed on that server, including requests running in confidential mode. The report says confidential computing does not protect against a vulnerability in the software running inside the environment. It doesn't say signing keys were exposed. Enzure's answer is the same as for a wrong answer: bonds, Appeal, and the DAO removing a key.
- **Registered Keys are checked off-chain by whoever proposes them.** `scripts/near-ai-attested-key.mts` fetches the model's attestation with a fresh nonce and checks that the TDX quote's report data binds the signing key to that nonce. It doesn't verify Intel's signature over the quote or the GPU attestation, and the contract doesn't verify attestation at all. Council members are trusted to check before voting.
- **Verdict shopping is limited, not prevented.** A Resolver could ask the model many times and submit only the answer it likes. The contract builds the request itself with temperature 0 and a seed it chose at dispute time, and a second valid verdict that differs (Conflicting Verdicts) sends the Assertion to the DAO. Someone has to submit that second verdict for this to work.
- **The demo oracle account has no full-access keys** ([step 2 of the key-free checks](verify.md)), so only DAO proposals can change its code or state. The development oracles still have full-access keys.
- **Chain Signatures and the Receiver.** An EVM Consumer trusts that only the oracle can get a signature from its derived address, which rests on the Chain Signatures MPC network. Moving the oracle to a new account changes that address and needs a new Receiver.
- **The escrow can't require a minimum Liveness.** The signed result message carries no Liveness, so the example escrow can't check how long the seller's Assertion was open to dispute. A seller could assert with the oracle's 1-minute minimum Liveness, so the buyer has to watch the oracle and dispute within that time. The demo buyer disputes as soon as the seller has asserted.
- **The storage service is a convenience, not a trust point.** Content is checked against its on-chain hash by the service, the web app, the Keeper and the scripts. If content is missing, the Assertion gets no AI Verdict and goes to the DAO after the deadline.
- **Nobody has to run the Keeper.** `settle`, `check_timeout`, `sign_hook`, `submit_ai_verdict` and Relayer delivery are open to anyone.
- **Demo timers are short.** The demo oracle uses 120 s Liveness, a 60 s Appeal Window and AI Verdict deadline, and a 600 s DAO deadline. The contract's defaults are 2 hours, 24 hours, 1 hour and 7 days.

## Known gaps

- No Base Sepolia deployment or transactions: no funded Base Sepolia key was available. The EVM side of the escrow runs was a local chain with Base Sepolia's chain id.
- The web app and the Keeper aren't hosted.
- The Keeper's Resolver doesn't submit second verdicts, so Conflicting Verdicts need someone else to submit one. They are covered by the sandbox tests.
- Bonds are native NEAR only. No mainnet, no NEAR Intents.
