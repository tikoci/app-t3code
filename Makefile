T3CODE_VER ?= 0.1.6
IMAGE ?= ghcr.io/tikoci/app-t3code
PLATFORMS ?= linux/amd64,linux/arm64

.PHONY: check test integration build push dev-lock

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

# Refresh the dev tool group's pinned lockfile after editing
# scripts/groups/dev/package.json. A changed lockfile gives every installed
# home a new payload on its next start (security refresh). `npm update`
# re-resolves transitive dependencies within their ranges (direct ones are
# exact pins) on a temp copy; the committed lockfile is replaced only if npm
# succeeds.
dev-lock:
	@tmp=$$(mktemp -d) && trap 'rm -rf "$$tmp"' EXIT && \
		cp scripts/groups/dev/package.json scripts/groups/dev/package-lock.json "$$tmp/" && \
		(cd "$$tmp" && npm update --package-lock-only --ignore-scripts --no-audit --no-fund) && \
		cp "$$tmp/package-lock.json" scripts/groups/dev/package-lock.json && \
		echo "updated scripts/groups/dev/package-lock.json"
