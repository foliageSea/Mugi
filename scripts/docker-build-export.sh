#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
PLATFORM=${MUGI_PLATFORM:-linux/amd64}
IMAGE=${1:-${MUGI_IMAGE:-mugi:amd64}}
OUTPUT=${2:-${MUGI_IMAGE_TAR:-$ROOT_DIR/mugi-amd64.tar}}

if ! command -v docker >/dev/null 2>&1; then
  printf '错误: 未找到 docker 命令\n' >&2
  exit 1
fi

if ! docker buildx version >/dev/null 2>&1; then
  printf '错误: 当前 Docker 不支持 buildx\n' >&2
  exit 1
fi

case "$OUTPUT" in
  /*) OUTPUT_PATH=$OUTPUT ;;
  *) OUTPUT_PATH=$ROOT_DIR/$OUTPUT ;;
esac

mkdir -p "$(dirname -- "$OUTPUT_PATH")"
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mugi-image.XXXXXX")
TEMP_OUTPUT=$TEMP_DIR/image.tar
cleanup() {
  rm -rf -- "$TEMP_DIR"
}
trap cleanup EXIT

printf '构建镜像: %s (%s)\n' "$IMAGE" "$PLATFORM"
docker buildx build \
  --file "$ROOT_DIR/Dockerfile" \
  --platform "$PLATFORM" \
  --tag "$IMAGE" \
  --output "type=docker,dest=$TEMP_OUTPUT" \
  "$ROOT_DIR"

mv -f -- "$TEMP_OUTPUT" "$OUTPUT_PATH"
printf '镜像已导出: %s\n' "$OUTPUT_PATH"
