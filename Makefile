T3CODE_VER ?= 0.1.6
IMAGE ?= ghcr.io/tikoci/app-t3code
PLATFORMS ?= linux/amd64,linux/arm64

.PHONY: check test integration build push

check:
	bun run check

test:
	bun run test

integration:
	bun run test:integration

build:
	docker buildx build --platform $(PLATFORMS) \
		--build-arg T3CODE_VER=$(T3CODE_VER) \
		-t $(IMAGE):$(T3CODE_VER) .

push:
	docker buildx build --platform $(PLATFORMS) --push \
		--build-arg T3CODE_VER=$(T3CODE_VER) \
		-t $(IMAGE):$(T3CODE_VER) \
		-t $(IMAGE):latest \
		.
