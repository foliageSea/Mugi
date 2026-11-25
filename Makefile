.PHONY: build build-windows build-macos frontend docker-export dev run test clean

frontend:
	npm run build

build:
	./scripts/build.sh

build-windows:
	npm run build:windows

build-macos:
	npm run build:macos

docker-export:
	./scripts/docker-build-export.sh

dev:
	./scripts/dev.sh

run: frontend
	go run ./cmd/mugi

test: frontend
	go test ./cmd/... ./internal/... ./web/...
	npm test

clean:
	rm -f bin/mugi
