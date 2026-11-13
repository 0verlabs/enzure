# Shared by the deploy scripts. Source it; don't run it.
#
# Set $root (the repository root) and $network (testnet or mainnet) first.
# load NAME then sets NAME, if it isn't already set, from that network's env
# files in the repository root, the first one that has it winning:
#   testnet: .env.testnet, then .env
#   mainnet: .env.mainnet only. CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
#            also fall back to .env, so testnet values in .env never reach a
#            mainnet deploy.

case "$network" in
  testnet) env_files=("$root/.env.testnet" "$root/.env") ;;
  mainnet) env_files=("$root/.env.mainnet") ;;
  *)
    echo "error: unknown network '$network'; use testnet or mainnet" >&2
    exit 1
    ;;
esac

# Prints the files load reads NAME from, one per line, existing ones only.
env_files_for() {
  local file
  for file in "${env_files[@]}"; do
    if [ -f "$file" ]; then echo "$file"; fi
  done
  case "$1" in
    CLOUDFLARE_API_TOKEN | CLOUDFLARE_ACCOUNT_ID)
      if [ "$network" = mainnet ] && [ -f "$root/.env" ]; then echo "$root/.env"; fi
      ;;
  esac
  return 0
}

# Sets $1 from the env files when it isn't already set. Like node --env-file,
# it drops a carriage return and one pair of surrounding quotes.
load() {
  local name="$1" value file
  if [ -n "${!name:-}" ]; then return 0; fi
  while IFS= read -r file; do
    value="$(sed -n "s/^${name}=//p" "$file" | tail -n 1 | tr -d '\r')"
    case "$value" in
      \"*\") value="${value:1:${#value}-2}" ;;
      \'*\') value="${value:1:${#value}-2}" ;;
    esac
    if [ -n "$value" ]; then
      export "$name=$value"
      return 0
    fi
  done < <(env_files_for "$name")
  return 0
}

# Prints the contents of the network's env files (not the .env fallback for
# Cloudflare credentials), for scanning them for variable names.
env_file_contents() {
  local file
  for file in "${env_files[@]}"; do
    if [ -f "$file" ]; then cat "$file"; fi
  done
  return 0
}
