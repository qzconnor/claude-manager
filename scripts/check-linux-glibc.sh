#!/usr/bin/env bash
# The native modules (node-pty) are compiled on the build system and link against its glibc. A newer
# glibc there means the packages don't load elsewhere: the app then ends before its window appears.
# Fails when a .node file in the Linux build needs a newer glibc than MAX_GLIBC.
set -euo pipefail

# Ubuntu 22.04 – the oldest distribution the packages are meant for.
MAX_GLIBC=2.35
root="${1:-release}"

found=0
while IFS= read -r -d '' file; do
  found=1
  need=$(objdump -T "$file" | grep -o 'GLIBC_[0-9.]*' | sed 's/^GLIBC_//' | sort -uV | tail -n 1)
  echo "$file: glibc ${need:-–}"
  if [ -n "$need" ] && [ "$(printf '%s\n%s\n' "$need" "$MAX_GLIBC" | sort -V | tail -n 1)" != "$MAX_GLIBC" ]; then
    echo "::error file=$file::needs glibc $need, the packages should run from glibc $MAX_GLIBC on"
    exit 1
  fi
done < <(find "$root" -path '*linux-unpacked*' -name '*.node' -print0)

if [ "$found" -eq 0 ]; then
  echo "::error::no native module found in $root/*/linux-unpacked"
  exit 1
fi
