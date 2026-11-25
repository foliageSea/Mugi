#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
OUTPUT=${MUGI_BUILD_OUTPUT:-"$ROOT_DIR/bin/mugi"}
LINK_FLAGS=()

if [[ "$(go env GOOS)" == "darwin" ]]; then
  LINK_FLAGS=(-ldflags=-linkmode=external)
fi

cd "$ROOT_DIR"

printf '构建前端资源...\n'
npm run build

printf '构建 mugi 二进制...\n'
mkdir -p "$(dirname -- "$OUTPUT")"
go build -trimpath "${LINK_FLAGS[@]}" -o "$OUTPUT" ./cmd/mugi

printf '构建完成: %s\n' "$OUTPUT"
