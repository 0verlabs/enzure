#!/usr/bin/env bash
# Runs every test suite in the repository: NEAR sandbox tests, Foundry tests,
# and the Vite+ checks and tests. Tool versions are listed in docs/toolchain.md.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

FOUNDRY_VERSION="1.7.1"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: '$1' not found. $2" >&2
    exit 1
  fi
}

step() {
  printf '\n==> %s\n' "$1"
}

require rustup "Install Rust from https://rustup.rs (see docs/toolchain.md)."
require cargo "Install Rust from https://rustup.rs (see docs/toolchain.md)."
require forge "Install Foundry with: foundryup --install ${FOUNDRY_VERSION}"
require vp "Install Vite+ with: curl -fsSL https://vite.plus | bash"

forge_version="$(forge --version | sed -n 's/^forge Version: \([0-9.]*\).*/\1/p')"
if [ "$forge_version" != "$FOUNDRY_VERSION" ]; then
  echo "warning: Foundry ${forge_version:-unknown} found, ${FOUNDRY_VERSION} expected (foundryup --install ${FOUNDRY_VERSION})." >&2
fi

if git rev-parse --git-dir >/dev/null 2>&1; then
  step "Fetching Foundry dependencies"
  git submodule update --init --recursive contracts/evm/lib/forge-std
fi

step "NEAR contracts: unit and sandbox tests"
(cd contracts/near && cargo test --locked)

step "EVM contracts: Foundry tests"
(cd contracts/evm && forge test)

step "Example EVM Consumer: Foundry tests"
(cd examples/evm-consumer && forge test)

step "Escrow demo: Foundry tests and the Claim template tests"
(cd examples/escrow && forge test)
node --test examples/escrow/agent/*.test.mts

step "TypeScript: install, check and test"
(cd typescript && vp install --frozen-lockfile && vp check && vp test)

step "All tests passed"
