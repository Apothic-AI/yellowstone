BINARY  := subrouterctl
LIBDIR  := build
LIB     := $(LIBDIR)/libsubrouter.so
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w \
	-X github.com/Apothic-AI/subrouterctl/internal/cmd.Version=$(VERSION) \
	-X github.com/Apothic-AI/subrouterctl/pkg/service.Version=$(VERSION)

.PHONY: all build install test smoke bindings bindings-python test-bindings fmt vet lint clean help

all: build ## Build the binary

build: ## Build ./subrouterctl for the current platform
	go build -trimpath -ldflags '$(LDFLAGS)' -o $(BINARY) ./cmd/subrouterctl

install: ## Install into $(GOBIN)
	go install -trimpath -ldflags '$(LDFLAGS)' ./cmd/subrouterctl

test: ## Run the unit tests
	go test ./...

smoke: build ## Run the live smoke test against the configured account
	./scripts/smoke.sh ./$(BINARY)

bindings: ## Build the shared library that the Python binding loads
	@mkdir -p $(LIBDIR)
	CGO_ENABLED=1 go build -buildmode=c-shared -ldflags '$(LDFLAGS)' -o $(LIB) ./bridge/cgo

bindings-python: bindings ## Put the shared library inside the Python package
	@mkdir -p packages/python/src/subrouterctl/_lib
	cp $(LIB) packages/python/src/subrouterctl/_lib/

test-bindings: build bindings ## Run the Python and TypeScript binding tests
	cd packages/python && PYTHONPATH=src python3 -m pytest tests -q
	cd packages/typescript && npm test

fmt: ## Format the source
	gofmt -w .

vet: ## Run go vet
	go vet ./...

lint: fmt vet ## Format and vet

clean: ## Remove build artefacts
	rm -f $(BINARY)
	rm -rf $(LIBDIR)

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'
