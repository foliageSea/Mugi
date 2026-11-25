#!/usr/bin/env bash

set -u

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
MUGI_ADDR=${MUGI_ADDR:-127.0.0.1:18080}
VITE_HOST=${VITE_HOST:-127.0.0.1}
VITE_PORT=${VITE_PORT:-5173}
BACKEND_PID=
FRONTEND_PID=

if [[ -z "${MUGI_ACCESS_MODE:-}" && -f "$ROOT_DIR/.env" ]]; then
  MUGI_ACCESS_MODE=$(sed -n 's/^MUGI_ACCESS_MODE=//p' "$ROOT_DIR/.env" | tail -n 1 | tr -d '"'"'"'[:space:]')
fi
ACCESS_MODE=${MUGI_ACCESS_MODE:-auto}
DEV_BINARY=$(mktemp -t mugi-dev.XXXXXX)
LINK_FLAGS=()

if [[ "$(go env GOOS)" == "darwin" ]]; then
  LINK_FLAGS=(-ldflags=-linkmode=external)
fi

if [[ $# -gt 0 ]]; then
  printf '用法: %s\n' "$0"
  exit 2
fi

stop_process() {
  local pid=${1:-}
  [[ -n "$pid" ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0

  kill "$pid" 2>/dev/null || true
  for _ in {1..20}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

stop_services() {
  stop_process "$FRONTEND_PID"
  stop_process "$BACKEND_PID"
  FRONTEND_PID=
  BACKEND_PID=
}

start_services() {
  stop_services

  printf '\n编译后端开发二进制...\n'
  if ! (cd "$ROOT_DIR" && go build -trimpath "${LINK_FLAGS[@]}" -o "$DEV_BINARY" ./cmd/mugi); then
    printf '后端编译失败，服务未启动。\n' >&2
    return 1
  fi

  printf '\n启动后端: http://%s (access=%s)\n' "$MUGI_ADDR" "$ACCESS_MODE"
  (
    exec "$DEV_BINARY" -addr "$MUGI_ADDR" -access "$ACCESS_MODE"
  ) &
  BACKEND_PID=$!

  printf '启动前端: http://%s:%s/\n' "$VITE_HOST" "$VITE_PORT"
  (
    exec "$ROOT_DIR/node_modules/.bin/vite" \
      --config "$ROOT_DIR/web/vite.config.ts" \
      --host "$VITE_HOST" \
      --port "$VITE_PORT"
  ) >/dev/null 2>&1 &
  FRONTEND_PID=$!
}

cleanup() {
  stop_services
  rm -f "$DEV_BINARY"
}

trap 'cleanup; exit 130' INT TERM
trap cleanup EXIT

if [[ ! -t 0 ]]; then
  printf '开发脚本需要交互式终端来接收 r/q 指令。\n' >&2
  exit 1
fi

start_services
printf '\n按 r 重启服务，按 q 退出。\n'

while IFS= read -r -n 1 -s key; do
  case "$key" in
    r|R)
      printf '\n重启服务...\n'
      start_services
      printf '服务已重启，按 r 重启，按 q 退出。\n'
      ;;
    q|Q)
      printf '\n正在退出服务...\n'
      break
      ;;
  esac
done
