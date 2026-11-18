#!/usr/bin/env sh
# Writes <dist>/manifest.json for an agent bundle laid out as <dist>/<platform>/<file>.
#   packaging/make-manifest.sh <dist-dir> <version>
set -eu
dist="${1:?dist dir}"
version="${2:?version}"
cd "$dist"
first=1
{
  printf '{\n  "version": "%s",\n  "files": [\n' "$version"
  for f in */*; do
    [ -f "$f" ] || continue
    platform="${f%%/*}"
    file="${f#*/}"
    size=$(wc -c < "$f" | tr -d ' ')
    sha=$(sha256sum "$f" | cut -d' ' -f1)
    [ $first -eq 1 ] || printf ',\n'
    first=0
    printf '    { "platform": "%s", "file": "%s", "size_bytes": %s, "sha256": "%s" }' "$platform" "$file" "$size" "$sha"
  done
  printf '\n  ]\n}\n'
} > manifest.json
echo "wrote $dist/manifest.json"
