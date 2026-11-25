# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/web-adb/package.json ./packages/web-adb/package.json
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json ./
COPY web ./web
COPY packages ./packages
COPY internal/adb/assets/app-icons.dex ./internal/adb/assets/app-icons.dex
RUN npm run build

FROM golang:1.26-bookworm AS backend
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY web/assets.go ./web/assets.go
COPY --from=frontend /src/web/dist ./web/dist
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/mugi ./cmd/mugi

FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends adb ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=backend /out/mugi /usr/local/bin/mugi
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENV HOME=/root \
    MUGI_TLS=false
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
