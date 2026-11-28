SANDBOX_IMAGE ?= seekkhein-python-sandbox:latest
RUNNER_LDFLAGS ?= -s -w

.PHONY: sandbox-image test build vet runner build-runner build-linux build-linux-arm64 build-windows build-all

sandbox-image:
	docker build -t $(SANDBOX_IMAGE) docker/python-sandbox

test:
	go test -race -v ./...

build:
	go build ./...

vet:
	go vet ./...

runner:
	go run ./cmd/runner

build-runner:
	CGO_ENABLED=0 go build -trimpath -ldflags="$(RUNNER_LDFLAGS)" -o bin/coderunner ./cmd/runner

build-linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="$(RUNNER_LDFLAGS)" -o bin/coderunner-linux-amd64 ./cmd/runner

build-linux-arm64:
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="$(RUNNER_LDFLAGS)" -o bin/coderunner-linux-arm64 ./cmd/runner

build-windows:
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="$(RUNNER_LDFLAGS)" -o bin/coderunner-windows-amd64.exe ./cmd/runner

build-all: build-linux build-linux-arm64 build-windows
