# Enzure

An AI optimistic oracle on NEAR. Bonded statements are accepted as true unless disputed; disputes get a first ruling from a TEE-signed AI and can be appealed to a DAO. Settled results are delivered to consumers on NEAR and on EVM chains.

## Language

### Assertions

**Assertion**:
A bonded statement posted to the oracle that is accepted as true unless it is disputed before its liveness window ends.
_Avoid_: Claim (for the whole object), statement, request, question

**Claim**:
The text of an Assertion: the statement whose truth is being asserted.
_Avoid_: Assertion text, statement, question

**Asserter**:
The party that posts an Assertion and its bond.
_Avoid_: Proposer, claimant, requester

**Disputer**:
The party that challenges an Assertion by posting a matching bond.
_Avoid_: Challenger, objector

**Liveness**:
The period after an Assertion is posted during which it can be disputed.
_Avoid_: Challenge period, dispute window

**Evidence**:
Material an Asserter or Disputer submits to support its side. It is stored off-chain; only its hash is recorded on-chain.
_Avoid_: Proof, attachment, context

### Resolution

**AI Verdict**:
The signed ruling a NEAR AI Cloud model, running in a TEE, gives on a disputed Assertion: TRUE, FALSE or UNRESOLVABLE. It is the first tier of resolution, not the final one.
_Avoid_: AI answer, AI result, AI resolution, judgment

**Registered Key**:
An AI signing key the DAO has approved. Only AI Verdicts signed by a Registered Key are accepted.
_Avoid_: Trusted key, oracle key, TEE key

**Prompt Template**:
The DAO-approved, versioned text that turns a Claim and its Evidence into the request sent to the model. Each Assertion is judged with the version current when it was posted.
_Avoid_: System prompt, instructions

**Resolver**:
Anyone who fetches a disputed Assertion's content, obtains an AI Verdict from NEAR AI Cloud, and submits it to the oracle.
_Avoid_: Arbiter, judge, oracle node

**Conflicting Verdicts**:
Two different AI Verdicts submitted for the same disputed Assertion. They send the Assertion straight to Appeal.
_Avoid_: Counter-verdict, double verdict

**Appeal**:
The step in which the DAO reviews a disputed Assertion and can overrule its AI Verdict. Only the party that lost the AI Verdict can start one. Its decision is final.
_Avoid_: Escalation, override, DVM

**Appeal Window**:
The period after the first AI Verdict during which the losing party can Appeal and Conflicting Verdicts send the Assertion to Appeal. When it closes with neither, the AI Verdict is final.
_Avoid_: Challenge period, verdict window

### Delivery

**Consumer**:
A contract, on NEAR or an EVM chain, that receives an Assertion's outcome through a Hook and acts on it.
_Avoid_: Integrator, subscriber, client

**Hook**:
The delivery of a settled Assertion's outcome to a consumer, either as a callback to a NEAR contract or as a signed result relayed to an EVM chain.
_Avoid_: Callback (for the general concept), webhook, notification, bridge message

**Receiver**:
The one contract on each EVM chain that accepts signed results from the oracle, records each Assertion's outcome once, and passes it to the consumer.
_Avoid_: Verifier, bridge, gateway

**Relayer**:
Anyone who carries a signed result from NEAR to a Receiver and pays the gas for it.
_Avoid_: bot, messenger

### Operations

**Scheduler**:
Anyone who calls the oracle's permissionless methods as soon as they become callable: `settle` when a timer ends, `check_timeout` when the AI Verdict deadline passes, and the calls that start Hook delivery. It decides nothing; the oracle checks every call.
_Avoid_: Cron, settler, bot

**Keeper service**:
The long-lived process Enzure runs that acts as Resolver, Scheduler and Relayer against one oracle. It holds no special rights: any of its calls could be made by anyone else.
_Avoid_: Keeper (alone, for a Relayer or Resolver), bot, daemon, backend
