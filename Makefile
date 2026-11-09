T3CODE_VER ?= 0.1.7
IMAGE ?= ghcr.io/tikoci/app-t3code
PLATFORMS ?= linux/amd64,linux/arm64

.PHONY: check lint lint-shell lint-actions lint-md test freshness share-link integration build push dev-lock

check:
	bun run check

# Every lint gate CI runs: biome + tsc + markdownlint (bun run check), then the
# shell and workflow linters, which need hadolint, shellcheck and actionlint
# on PATH.
lint: check lint-shell lint-actions

# The Dockerfile (hadolint, which also runs ShellCheck on its RUN steps) and
# every shell script that ships in the image or runs in its tests. CI runs
# this with pinned, checksum-verified hadolint and ShellCheck (ci.yml).
SHELL_SCRIPTS = bin/* docker-entrypoint.sh profile.sh scripts/install-pairing-help.sh test/*.sh

lint-shell:
	hadolint Dockerfile
	shellcheck $(SHELL_SCRIPTS)

# The workflows in .github/workflows. actionlint also runs ShellCheck on each
# `run:` script when shellcheck is on PATH. CI pins it like hadolint.
lint-actions:
	actionlint

lint-md:
	bun run lint:md

test:
	bun run test

# Drift checks (scripts/freshness.ts): the README share link, T3CODE_VER's
# release and its harness catalog, the newest stable T3, and Claude Code's
# download channel and manifest (bin/install-claude-code). Needs network;
# CI runs `pinned` on every PR and everything on a schedule (freshness.yml).
freshness:
	bun scripts/freshness.ts all --version $(T3CODE_VER)

# Regenerate the README's /app YAML Editor link from app/t3code.tikapp.yaml.
share-link:
	bun scripts/freshness.ts share-link --write

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
