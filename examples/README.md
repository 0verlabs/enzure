# Examples

Example and demo code, including example Consumers and the escrow demo with its seller agent (ADR 0005). Nothing here is deployed as part of Enzure itself.

- `escrow/`: the flagship demo. An escrow on Base Sepolia pays a seller agent or refunds the buyer from an Enzure ruling; with the buyer script, the seller agent and `demo.sh`, which runs the whole flow.
- `evm-consumer/`: a minimal EVM Consumer that records the outcomes its Receiver delivers.
- `near-consumer/`: a minimal NEAR Consumer for NEAR Hooks.
