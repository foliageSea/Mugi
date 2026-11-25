#!/bin/sh

set -eu

exec /usr/local/bin/mugi \
    -addr 0.0.0.0:8080 \
    -certdir /root/.mugi \
    -tls="${MUGI_TLS:-false}" \
    -access="${MUGI_ACCESS_MODE:-auto}" \
    "$@"
