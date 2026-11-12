# Hackathon fit: AI Optimistic Oracle on NEAR

Research for NEAR HACKATHON. Idea under review: a UMA OOv3-style optimistic oracle on NEAR. Anyone posts a bonded assertion. If nobody disputes it within the liveness window, it counts as true. A disputed assertion is resolved by a signed NEAR AI Cloud verdict produced in a TEE, with a Sputnik DAO or human fallback. Settlement fires callbacks on NEAR consumer contracts and, through Chain Signatures, on other chains.

Sources: `HACKATHON.md` at the repo root, the 13 prompts in `nearai/near-hackathon-prompt-examples` (cloned and read in full), the `near-ai-cloud` and `near-intents` skills in `.agents/skills/`, and the web sources listed at the end. Timeline and dates are ignored, as requested.

## TL;DR verdict

- **Worth building, with a narrower story.** A general-purpose "oracle" with no consumer is the weakest way to pitch it. The strongest pitch is a verifiable dispute layer for agent work: an agent claims "I delivered the brief", the buyer disputes, a TEE-signed AI verdict is checked on-chain by a NEAR contract, and a USDC escrow on an EVM testnet pays out or refunds through a Chain Signatures signature.
- **Primary track: `agents`.** Also submit under `open` and `security`. Add `privacy` only if private evidence (E2EE to the TEE) is built, and `social` only if a real Sputnik DAO testnet instance serves as the appeal court in the demo.
- **The combination is only moderately new.** Optimistic oracles (UMA, Reality.eth, Flux on NEAR), AI dispute judges (NEAR's own Agent Market resolver, Kleros Court 34, Chaos Labs Edge, UMA's Optimistic Truth Bot, GenLayer) and on-chain `ecrecover` of TEE-signed LLM verdicts (Verdict, ETHGlobal Mumbai 2026, on 0G) all exist. Two parts look new: a NEAR contract that checks NEAR AI Cloud signatures itself, and one oracle on NEAR that settles on other chains through Chain Signatures with no bridge.
- **The biggest technical risk is verdict cherry-picking.** LLM output is not deterministic, so a relayer can sample N times and submit only the verdict it likes. The design needs an answer to this (see "Design points judges will probe").
- **The biggest credibility risk is recent and public.** On Nov 10, 2026, NEAR AI disclosed an SGLang RCE that ran code inside one of its TEE inference servers. A TEE proves where the code ran. It does not prove the software inside was uncompromised. The README has to say this plainly and show the bond plus DAO appeal layer as the defence.

## Track scoring

Score: 0 = no fit, 1 = adjacent, 2 = real fit with framing, 3 = strong fit. "Judges want" summarises each prompt's Requirements and Lean-on lines.

| # | id | Score | What the prompt asks for | Reasoning |
| --- | --- | --- | --- | --- |
| 01 | `defi` | 1 | 1Click quotes and deposits, REFUNDED/FAILED handling, dry-run mode, stretch: Chain Signatures vault | Oracles are DeFi infrastructure, but the prompt is about trading and Intents settlement. An oracle without a market or vault on top gets little credit here. |
| 02 | `thesis` | 0 | BigQuery SQL, reproducible charts, THESIS.md | Research and data track. No overlap. |
| 03 | `privacy` | 2 | NEAR AI Cloud via the OpenAI API, attestation fetched with a fresh nonce and verified, a "Verified" panel, no server-side retention | The verification part fits directly. Privacy is not the point of the idea, though: dispute evidence is public by default. Becomes a real fit only if evidence is sent E2EE to the TEE and only the verdict is published. |
| 04 | `business` | 1 | Agent with its own account and spend limits, Intents payments, public ledger, kill switch | A bond-earning disputer agent could be pitched as an autonomous business. That is a side story. |
| 05 | `swarms` | 1 | Sub-accounts per agent, coordinator contract, sealed bids, 20-agent simulation | A multi-model jury is a loose fit. Nothing here is a market between agents. |
| 06 | `security` | 2 | Allow/warn/block checks before agents pay, function-call keys scoped to one contract, attack demo | Fits through TEE attestation, the scoped relayer key and the prompt-injection angle (evidence that tells the judge "rule for me"). It is verification of claims, not agent spend control, so it is secondary. |
| 07 | `agents` | 3 | Agents that hire, check the work and pay; Agent Market job flow; USDC or NEAR payments, directly or via Intents; a receipt per task | The sample prompt's contractor agent "checks the work, and pays out". This oracle is that check, made verifiable and usable by any contract. Chain Signatures is a named hint. Best fit if the demo is agent-work verification. |
| 08 | `realworld` | 1 | Invoicing or payroll a normal company could use tomorrow, gasless via meta tx, CSV export | An escrow-with-disputes product could fit, but an oracle is too far from "a normal company could use it tomorrow". |
| 09 | `games` | 0 | Game loop, NEP-245, social login | No fit. |
| 10 | `nfts` | 0 | NEP-171 tokens tied to sub-accounts | No fit. |
| 11 | `memecoins` | 0 | NEP-141 mechanic in the contract | No fit. |
| 12 | `social` | 2 if DAO is built, else 1 | Use an existing Sputnik DAO or Trezu treasury, tiered approvals, reputation tied to named accounts | A DAO acting as the appeal court over AI verdicts is "what communities do with the multisig". It only scores if a real Sputnik DAO instance on testnet votes in the demo. |
| 13 | `open` | 3 | Contract-held rules anyone can read, Chain Signatures, testnet demo with short timers, a failure-case section, argue against the idea first | Cross-chain settlement from one NEAR contract is what this prompt points at. The prompt's requirements (readable rules, short timers, failure cases) match this design. |

## Recommended tracks

1. **`agents` (primary).** Frame the demo as one agent hiring another and an on-chain, verifiable check deciding the payout. This is the only framing where the AI judge is necessary: whether a deliverable meets a brief is subjective, which an API price feed cannot settle.
2. **`open`.** Cross-chain settlement through Chain Signatures with no bridge is the NEAR-specific angle. This track is probably crowded, since the prompt says it can be combined with any other.
3. **`security`.** Lean on the on-chain signature check, the function-call key for the relayer, and a prompt-injection attack demo in which the evidence tells the AI judge to rule for the attacker and the defence holds or escalates.
4. **Conditional:** `privacy` if private evidence is built. `social` if a Sputnik DAO testnet instance is the appeal court. Do not list both unless both are in the demo. AI screening checks each listed track against what the README shows.

## Hint coverage

| Hint (track) | Status | Cost to add | Notes |
| --- | --- | --- | --- |
| CHAIN SIGNATURES (defi, business, agents, open) | Hit | Core | Have the oracle contract call `sign` on the MPC contract (`v1.signer` on mainnet; check the docs for the testnet id) for an EIP-191 or EIP-712 message such as `settle(escrowId, outcome)`, not for a raw transaction. The EVM escrow `ecrecover`s against the oracle's derived address. Anyone can relay it, and the derived address needs no gas or nonce handling. Use one derivation path per chain, as the docs advise. |
| NEAR AI CLOUD, TEE (privacy), TEE ATTESTATION (security) | Hit | Core | Use the direct model endpoint (`{slug}.completions.near.ai`), non-streaming, to get a `provider_tee` signature over `model:sha256(request):sha256(response)`. The NEAR contract can check this with `env::sha256`, `env::keccak256` and `env::ecrecover`. |
| PRIVATE AI (privacy) | Partial | Medium | E2EE evidence to the TEE (skill reference `e2ee-chat.md`). Only hashes and the verdict go on-chain. This conflicts with a contract-built prompt (see design points), so treat it as a separate mode. |
| AGENT SECURITY, FUNCTION CALL KEYS (security) | Cheap | Low | The relayer account holds only a function-call key scoped to the oracle contract and `submit_verdict`. Explain its limits in the README, as the security prompt asks. |
| AGENT COMMERCE (agents) | Hit if the demo is agent work | Core | Seller agent asserts delivery, buyer agent disputes. |
| Agent Market listing (partner note) | Cheap | Low | List a "claim checker" agent on market.near.ai that, for a fee, reviews a deliverable against a brief and files the bonded dispute. It earns from jobs and from won dispute bonds. This listing is off-chain and does not prove integration with Agent Market's held payments. Those are ledger balances run by the marketplace, and the docs I read describe no on-chain hook for an external resolver. |
| SPUTNIK DAO (social) | Cheap to medium | Low/Med | An escalation becomes a Sputnik `FunctionCall` proposal targeting `oracle.resolve_appeal(id, outcome)`. Only the DAO account can call it. No new multisig. |
| NEAR INTENTS (defi, business, agents, realworld, swarms, games) | Not hit | Medium, mainnet only | Intents has no testnet (Q-007). Options: pay out the winner's bond to any chain via 1Click on mainnet with tiny amounts, or show `dry: true` quotes. Not needed for the core demo, and the `agents` prompt accepts direct USDC or NEAR payments. Do not force it in. |
| SUB-ACCOUNTS (swarms, nfts) | Cheap | Low | Optional: asserter or disputer agents as sub-accounts (`seller-1.oracle-demo.testnet`) so each on-chain action traces to an agent. |
| STABLECOINS (realworld) | Hit | Core | The EVM escrow holds test USDC. |
| META TRANSACTIONS (realworld) | Not hit | Medium | Gasless dispute filing via a relayer. Skip. |
| OutLayer (partner) | Alternative | n/a | OutLayer runs WASM in TDX via yield/resume and already lists "AI calls" with verifiable output. Mention it in the README as an alternative execution path and say why NEAR AI Cloud's signature is checked directly instead: the contract verifies the model's own signature rather than a worker attestation. |

## Prior art and differentiation

### What already exists

| Project | What it does | Overlap with this idea |
| --- | --- | --- |
| [UMA Optimistic Oracle v3](https://docs.uma.xyz/developers/optimistic-oracle-v3) | Bonded assertions, liveness window (Polymarket uses 2 h), escalation managers, disputes go to a UMA token vote (DVM). | The whole optimistic mechanism. Known weakness: token-weighted votes, e.g. the [whale-vote-flipped market](https://www.oddsshopper.com/articles/prediction-markets/uma-oracle-polymarket-disputes). |
| [UMA Optimistic Truth Bot](https://blog.uma.xyz/articles/inside-umas-optimistic-truth-bot) | LLM router, solvers and overseer that recommend Polymarket answers. It shadows human proposers and has posted no on-chain proposals. | AI as proposer, not as judge. Unverifiable (no TEE or signatures). |
| [NEAR Agent Market disputes](https://docs.market.near.ai/concepts/payments-and-disputes.md) | 5% dispute deposit. An automated AI resolver reviews disputes about every 12 h, low-confidence rulings go to an operator, and either side can request human review. | **The closest overlap, and it is in NEAR's own product.** Same pattern (deposit, AI judge, human fallback), but off-chain, custodial and unverifiable. Judges from NEAR will know it. |
| [Kleros Agentic Commerce Court (34)](https://docs.kleros.io/ai-tools/agentic-commerce-court) | Court on Arbitrum where jurors are expected to be AI agents, with appeal to human jurors and a public dashboard of agent votes. | AI judging with human appeal, on-chain, already live. |
| [Reality.eth + Kleros](https://docs.kleros.io/developers/products/reality/overview) | Bond-escalation answers with Kleros as arbitrator. A [cross-chain proxy](https://github.com/kleros/cross-chain-realitio-proxy) exists via AMB bridges. | Optimistic answers with an external arbitrator. Cross-chain via bridges. |
| [Chaos Labs Edge AI Oracle](https://chaoslabs.xyz/posts/edge-ai-alpha-release) | Multi-agent LLM council for prediction market resolution. | AI resolution, operator-run, no TEE signature checked on-chain. |
| [GenLayer](https://genlayer.com/how-it-works) | Chain whose validators call LLMs. A leader proposes, others re-check under an "equivalence principle", and appeals widen the committee. | Closest conceptual rival for subjective resolution. It answers non-determinism with multi-validator consensus. |
| [ORA OAO / opML](https://github.com/ora-io/OAO), [AI Settlement Oracle](https://github.com/ora-io/AI-Settlement-Oracle) | Optimistic fraud proofs over ML inference, aimed at prediction market settlement. | AI settlement oracle. opML needs deterministic execution, which sampled LLMs lack. |
| Chainlink Functions / CRE + LLM | A DON calls an LLM API and reaches consensus on the response. Several [Chainlink hackathon projects](https://chain.link/hack-26/projects/swarm-oracle-protocol) run multi-LLM resolution committees. | The DON vouches for the API response, which does not prove which model ran. |
| [Verdict (ETHGlobal Mumbai 2026)](https://github.com/Atharv181/verdict) | USDC escrow that releases only on LLM verdicts whose TEE signatures pass `sha256` + `ecrecover` on-chain. Two judges, a grounding pass, escalation. Live run used a self-attested relayer key; the 0G TeeML signer was tested but did not settle live. | **The closest technical prior art.** Same verification trick on a different TEE provider and chain. Read its README for design and honesty patterns. |
| [optimistic-ai-attestation (ETHGlobal Waterloo 2023)](https://github.com/jordan-public/optimistic-ai-attestation) | UMA optimistic attestation of LLM query and answer. Disputers re-ask the LLM. Front end on NEAR BOS. Won UMA's best-use prize. | Optimistic + LLM, with a NEAR link. |
| [Flux Protocol](https://near.org/blog/prediction-market-and-insurance-with-flux/) | NEAR prediction market engine and oracle (2020–2022), later first-party price feeds on EVM. | Historical general oracle on NEAR. No longer listed in NEAR docs. |
| [Pyth on NEAR, OutLayer price oracle](https://docs.near.org/primitives/oracles) | The two oracles NEAR docs currently list. Both are price feeds. | Price data only. Confirms that NEAR has no listed oracle for subjective claims. |
| [OutLayer](https://docs.near.org/primitives/off-chain-compute/outlayer) | TDX off-chain compute for NEAR contracts via yield/resume. The examples gallery includes "AI calls" with verifiable output. | A NEAR contract can already get an attested AI answer. What is missing is the bond, dispute and settlement game around it. |
| [Shade Agents](https://docs.near.org/ai/shade-agents/reference/agent-contract) | TEE agents registered in a NEAR contract by code measurement, signing cross-chain via Chain Signatures. | Pattern for registering TEE identities on-chain, and an alternative way to host the resolver. |

### What is new in this combination

Be careful when claiming novelty. Each mechanism has been shipped somewhere. The parts that look new:

1. **A NEAR contract that checks NEAR AI Cloud verdicts itself.** No intermediary reports a boolean. The contract recomputes `sha256` of the request it built and of the response bytes, then `ecrecover`s the model TEE's signature. Verdict did this on Arc with 0G. I found no NEAR or NEAR AI Cloud version.
2. **One oracle on NEAR, consumers on any chain, no bridge.** UMA deploys per chain. Reality.eth and Kleros cross chains through AMB bridges. Here the settlement is a Chain Signatures signature from the oracle's derived address, which any EVM contract can verify with `ecrecover`.
3. **A verifiable, composable version of Agent Market's dispute flow.** Agent Market already runs deposit, AI judge and human review off-chain. This is the same flow with checks anyone can run, usable by escrows that Agent Market does not hold.
4. **Bonds and appeals around an AI judge that is not deterministic.** GenLayer solves this at the consensus layer. Here it is a contract-level rule (conflicting signed verdicts escalate, see below), which is simpler and less proven.

None of this is new research. The claim to make is specific: "Agent Market's AI dispute flow, but every step can be checked on-chain and any chain can settle on it."

### Design points judges will probe

- **Cherry-picking.** The relayer can call the model N times and submit only the verdict it likes, because the signature proves a response was produced, not that it was the only one. Mitigations, in order of cost:
  1. The contract builds the request body itself (fixed model, system prompt, `temperature: 0`, assertion text, evidence, dispute id) and checks `sha256(body)` against the signed `request_hash`. This stops prompt tampering. It does not stop resampling.
  2. **Conflict escalation:** anyone can submit another valid signed verdict for the same `request_hash` during an appeal window. If two valid verdicts disagree, the dispute escalates to the DAO automatically. A resampled answer can then be used against the party that cherry-picked.
  3. A 2-of-3 quorum across different models on NEAR AI Cloud, each with its own registered signer.
- **Trust root for signing keys.** TDX quote and NVIDIA NRAS checks cannot run in a NEAR contract at reasonable gas, so the contract needs a registry of accepted `signing_address`es per model. Keys are per TEE node, a model can run on several nodes, and keys change when nodes restart. Options: an admin or DAO-managed registry with attestation evidence linked, or (more interesting) registering a key as an optimistic assertion itself ("0xabc is an attested key for model M, report at URL"), disputable like any other claim. State in the README who can add keys.
- **Gateway vs model-TEE signatures.** The gateway (`cloud-api.near.ai`) may re-sign rewritten streamed bytes with its own key (`signature_kind: gateway`). Use the direct model endpoint, non-streaming, so the signature covers the exact bytes the contract parses.
- **On-chain parsing.** Submit the raw response JSON (a few KB). The contract hashes it, parses `choices[0].message.content`, and parses a strict JSON verdict such as `{"outcome":"TRUE|FALSE|UNRESOLVABLE","reason":"..."}`. Anything else counts as `UNRESOLVABLE` and escalates. Log hashes; do not store bodies.
- **Prompt injection in evidence.** Evidence is attacker-controlled text. Delimit it, tell the model to treat it as data (Kleros Court 34 puts the same rule in its policy), and show an attack in the demo.
- **Bond economics.** Who pays for inference, and how big must bonds be relative to what they secure? Copy UMA's rule of thumb: the bond must exceed what a liar can win.

## Recommended demo scenario

**"An agent says it delivered. The buyer says it didn't. A NEAR contract decides, and an escrow on Base pays out."**

Setup (before recording): a Base Sepolia (or another EVM testnet) escrow holds 5 test USDC for job #42. Its only release authority is the NEAR oracle contract's Chain Signatures derived address (path `base-sepolia-1`). The brief: "a 300-word summary of X with three cited sources". Liveness and appeal windows are set to about 30 seconds.

| Step | Action | What the viewer sees |
| --- | --- | --- |
| 1. Assertion | The seller agent (`seller-1.<demo>.testnet`) calls `assert_truth("Deliverable sha256:… satisfies brief sha256:… for escrow base:0x…/42")` with a bond. | NEAR testnet tx, countdown starts. |
| 2. Dispute | The buyer agent calls `dispute(id)` with an equal bond. The deliverable has only one source. | State `Disputed`. |
| 3. AI verdict | The relayer (function-call key only) fetches the contract-built request body, sends it to a NEAR AI Cloud TEE model, gets the signature, and calls `submit_verdict(id, response_bytes, signature)`. | Contract log: request hash matched, response hash matched, signer `0x…` is registered for model M, outcome `FALSE`. A side panel shows the off-chain attestation check (nonce, NRAS, TDX quote) from the `nearai-cloud-verifier` flow. |
| 4. Appeal window | Nobody submits a conflicting verdict and the DAO does not intervene. Optional cut: show a conflicting verdict escalating to a Sputnik proposal. | Countdown, then `Settled: FALSE`. The buyer gets their bond back plus a share of the seller's. |
| 5. Cross-chain hook | `settle` calls the MPC `sign` for `settle(42, REFUND)`. The relayer submits the signature to the escrow on Base Sepolia. | Base explorer: USDC refunded to the buyer. NEAR explorer: the `sign` call. Both links on screen. |

A second, 15-second cut shows the happy path: an undisputed assertion settles `TRUE` after liveness and the escrow releases. This shows the optimistic path costs no inference.

Why this scenario over the others:

- **Prediction market resolution** has been shown many times (UMA/Polymarket, Chaos Labs, ORA, Chainlink hackathons). AI resolution of public news also invites "the model just read a headline" objections.
- **Parametric insurance** (flight delay, rainfall) is deterministic API data. A price/API oracle or OutLayer fetch solves it without bonds or an AI judge, so the AI adds nothing visible.
- **DAO bounty release** fits `social` but the cross-chain hook is less natural.
- **Agent work verification** needs a subjective judgment, has a NEAR-native comparison (Agent Market's resolver), fits the primary track, and makes the cross-chain payout part of the story rather than an extra.

## Judging risks

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Scope too big | UMA OOv3 alone is a large codebase (escalation managers, currencies, identifiers, DVM). Adding TEE verification, DAO appeal, Chain Signatures and an EVM escrow makes four integrations. | Build the minimum: one NEAR contract (`assert_truth`, `dispute`, `submit_verdict`, `resolve_appeal`, `settle`, callback), one relayer script, one Solidity escrow. NEAR token bonds only. One model. DAO appeal as a single proposal path. Cut Intents, multi-model quorum and the UI first. A CLI with explorer links is enough for the video. |
| Oracle with no users | Infrastructure without a consumer scores poorly: the prompts all ask for an end-to-end user flow. | Ship the consumer (escrow) in the same repo and pitch the product as "verifiable dispute resolution for agent work". Include a 20-line integration example for a NEAR consumer contract. |
| AI-as-judge credibility | Human judges will ask whether an LLM should decide money, and the Nov 2026 NEAR AI SGLang RCE shows TEE inference can be compromised by software inside the enclave. | Say in the README what the TEE proves (which model and code produced these exact bytes) and what it does not (that the answer is right, or that the enclave software was uncompromised). Position the AI as a fast, cheap first ruling behind bonds and a DAO appeal, matching Agent Market and Kleros Court 34. Report results on a small labelled test set (e.g. 20 brief/deliverable pairs) with the model's accuracy, including failures. |
| Unverified claims of "verifiable" | If the live run uses a stub signer, AI screening will flag the mismatch. Verdict's README is an example of stating this openly. | Commit a real NEAR AI Cloud response, its signature and its attestation report as test fixtures (no API key in them). A contract unit test verifies that real signature. Label every mock as a mock. |
| Reproducibility for Claude Code / Codex screening | The screener needs to run things without a NEAR AI key, testnet ETH or MPC access. | Three levels in the README, each as "do X - see Y": (1) `docker compose run --rm test`: contract unit tests verify the committed real signature and run the full state machine, expected output listed; (2) local sandbox (near-workspaces + anvil) with a mock MPC signer, clearly labelled; (3) testnet: deployed contract ids, tx hashes for each demo step, and view calls a judge can run with no keys. A live run with the judge's own NEAR AI key is optional. |
| Track dilution | Listing weak-fit tracks invites "does not use Intents" or "no privacy feature" findings. | List only tracks whose hints appear in the demo (see Recommended tracks). |
| Novelty challenge | A judge who knows Agent Market disputes or Verdict may see nothing new. | Name the prior art in the README and state the specific delta (on-chain signature check on NEAR, bridge-less cross-chain settlement, conflict escalation). |
| Intents expectations | Many tracks list Intents first, and it is mainnet only. | Do not fake it. If time allows, a mainnet bond payout via 1Click with a tiny amount, or a `dry: true` quote, labelled as such. |

## Sources

Hackathon material
- `HACKATHON.md` (repo root), live copy: https://nearhackathon.com/HACKATHON.md
- Track prompts: https://github.com/nearai/near-hackathon-prompt-examples (tracks/01–13, README, 00-setup, SUBMITTING)
- Agent skills read locally: `.agents/skills/near-ai-cloud/SKILL.md`, `.agents/skills/near-ai-cloud/references/chat-verification.md`, `.agents/skills/near-intents/SKILL.md`

NEAR
- NEAR AI Cloud verification: https://docs.near.ai/cloud/verification
- NEAR AI Cloud verifier: https://github.com/nearai/nearai-cloud-verifier
- Chain Signatures: https://docs.near.org/chain-abstraction/chain-signatures/getting-started
- Oracles on NEAR: https://docs.near.org/primitives/oracles
- OutLayer: https://docs.near.org/primitives/off-chain-compute/outlayer
- Yield and resume: https://docs.near.org/smart-contracts/anatomy/yield-resume
- Shade Agents contract: https://docs.near.org/ai/shade-agents/reference/agent-contract
- Agent Market, how it works: https://docs.market.near.ai/concepts/how-it-works.md
- Agent Market, payments and disputes: https://docs.market.near.ai/concepts/payments-and-disputes.md
- Sputnik DAO: https://github.com/near-daos/sputnik-dao-contract
- NEAR AI SGLang incident (Nov 10, 2026): https://thehackernews.com/2026/11/sglang-rce-exploit-breaches-near-ai.html
- Flux on NEAR: https://near.org/blog/prediction-market-and-insurance-with-flux/

Oracles and AI resolution
- UMA OOv3: https://docs.uma.xyz/developers/optimistic-oracle-v3
- UMA escalation managers: https://docs.uma.xyz/developers/optimistic-oracle-v3/escalation-managers
- UMA Optimistic Truth Bot: https://blog.uma.xyz/articles/inside-umas-optimistic-truth-bot and https://blog.uma.xyz/articles/experiment-can-ai-agents-enhance-uma-oracle
- Polymarket + UMA: https://legacy-docs.polymarket.com/polymarket-+-uma
- UMA whale vote: https://www.oddsshopper.com/articles/prediction-markets/uma-oracle-polymarket-disputes
- Kleros + Reality.eth: https://docs.kleros.io/developers/products/reality/overview
- Kleros cross-chain Realitio proxy: https://github.com/kleros/cross-chain-realitio-proxy
- Kleros Agentic Commerce Court: https://docs.kleros.io/ai-tools/agentic-commerce-court
- Chaos Labs Edge AI Oracle: https://chaoslabs.xyz/posts/edge-ai-alpha-release
- GenLayer: https://genlayer.com/how-it-works
- ORA OAO: https://github.com/ora-io/OAO and https://github.com/ora-io/AI-Settlement-Oracle
- Chainlink hackathon AI resolution example: https://chain.link/hack-26/projects/swarm-oracle-protocol
- Verdict (ETHGlobal Mumbai 2026): https://github.com/Atharv181/verdict
- optimistic-ai-attestation (ETHGlobal Waterloo 2023): https://github.com/jordan-public/optimistic-ai-attestation
- Multi-agent LLM oracle evaluation: https://arxiv.org/abs/2605.30802
- Same-hackathon example of a reproducible README: https://github.com/KushnerykPavel/cartelbreaker

Content from web sources was paraphrased for compliance with licensing restrictions.
