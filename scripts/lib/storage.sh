# Shared by the storage scripts. Source it; don't run it.

# The deployed storage service (typescript/apps/storage).
STORAGE_URL="${STORAGE_URL:-https://enzure-storage.luckzivanius.workers.dev}"
STORAGE_URL="${STORAGE_URL%/}"

# Prints the sha256 of a file as lowercase hex.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}
