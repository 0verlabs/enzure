# Example EVM Consumer

An EVM contract that learns Assertion outcomes from the Enzure oracle through an EVM Hook. The Receiver on its chain calls `assertionResolvedCallback(assertionId, truthful, claimHash, asserter)`; the example accepts calls only from the Receiver it was deployed with and records each Assertion's first result, ignoring repeats (anyone can make the Receiver call it again with `retryCallback`).

`asserter` is the sha256 of the Asserter's NEAR account id, so a Consumer checks who asserted by comparing it with `sha256(bytes("alice.testnet"))`.

Post an Assertion naming it in an EVM Hook:

```json
"hooks": [{ "evm": { "chain_id": 84532, "receiver": "<Receiver address>", "consumer": "<this contract>" } }]
```

```bash
forge test                                                              # tests, with the real testnet signature fixture
../../scripts/deploy-receiver.sh <oracle-account> --with-example-consumer  # deploy a Receiver and this contract
```

It shares forge-std and the Receiver sources with `contracts/evm` through remappings in `foundry.toml`.
