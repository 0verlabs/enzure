# Toolchain

Run every test suite from the repository root with `./scripts/test.sh`. It needs network access the first time, to fetch forge-std, crates, npm packages and the NEAR sandbox binary.

| Tool | Version | Where it is pinned | Install |
| --- | --- | --- | --- |
| Vite+ (`vp`) | 1.6.0 in the project | `typescript/pnpm-workspace.yaml` catalog | `curl -fsSL https://vite.plus \| bash` |
| Node.js | 26.13.1 | `devEngines.runtime` in `typescript/package.json`; `vp` downloads it | Managed by `vp` |
| pnpm | 12.18.0 | `devEngines.packageManager` in `typescript/package.json`; `vp` downloads it | Managed by `vp` |
| Rust | 1.95.0 with `wasm32-unknown-unknown` | `contracts/near/rust-toolchain.toml`; rustup installs it | [rustup.rs](https://rustup.rs) |
| near-sdk | 5.30.1 | `contracts/near/Cargo.toml` and `Cargo.lock` | Cargo |
| cargo-near | 0.23.0 | Documented here; the tests build Wasm through the `cargo-near-build` crate, pinned in `Cargo.lock` | `cargo install --locked cargo-near@0.23.0` |
| Reproducible Wasm build | cargo-near 0.23.0 with Rust 1.99.1 in Docker | `[package.metadata.near.reproducible_build]` in `contracts/near/oracle/Cargo.toml`, by image digest | `cargo near build reproducible-wasm` (needs Docker) |
| Foundry | 1.7.1 | Documented here; `scripts/test.sh` warns on a different version | `foundryup --install 1.7.1` |
| solc | 0.8.30 | `contracts/evm/foundry.toml`; Foundry downloads it | Managed by Foundry |
| forge-std | v1.17.0 | Git submodule at `contracts/evm/lib/forge-std` and `foundry.lock` | `git submodule update --init` |

Run Vite+ commands through `vp`, not a global `pnpm`: `vp install`, `vp check`, `vp test`.

Build the NEAR contract to Wasm from its crate folder, because `contracts/near` is a virtual workspace:

```bash
cd contracts/near/oracle && cargo near build non-reproducible-wasm
```
