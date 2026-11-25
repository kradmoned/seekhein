SANDBOX_IMAGE ?= seekkhein-python-sandbox:latest

.PHONY: sandbox-image test build vet runner

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
