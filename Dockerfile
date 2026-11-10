# tikoci/app-t3code — RouterOS /app container for T3 Code.
#
# Rebuilds the wodby/t3code approach from our own Dockerfile so the image we
# ship on GHCR is one we control: Debian trixie-slim (glibc, which the T3 Code
# release binaries need), per-arch t3 tarball from pingdotgg/t3code with
# SHA256 verification, the GitHub CLI, uv/uvx and Bun/RouterOS tools baked
# in. No provider CLI is baked: the T3APP_PROVIDERS selection (#13) installs
# Claude Code, Codex and the others into the volume in the background.
#
# Build:
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     --build-arg T3CODE_VER=0.1.7 -t ghcr.io/tikoci/app-t3code:0.1 .
# Run (plain HTTP on 3773; terminate TLS in front for remote use):
#   docker run -p 3773:3773 -v t3code:/data -e PUBLIC_URL=https://t3.example.com ghcr.io/tikoci/app-t3code:0.1

ARG NODE_VER=24
ARG BUN_VER=1.4.4
ARG UV_VER=0.13.7

FROM oven/bun:${BUN_VER}-slim AS bun

# Astral's multi-arch distroless image carries only the static uv and uvx.
FROM ghcr.io/astral-sh/uv:${UV_VER} AS uv

FROM node:${NODE_VER}-trixie-slim AS runtime

ARG TARGETARCH
ARG T3CODE_VER=0.1.7
ARG QUICKCHR_VER=next
ARG CENTRS_VER=next
ARG GH_VER=2.103.3

ENV T3CODE_VER="${T3CODE_VER}"
ENV T3CODE_HOST=0.0.0.0
ENV T3CODE_PORT=3773
# RouterOS `/app/set environment=` replaces the whole env list, so anything
# the /app YAML sets must also be an image default here (issue #5).
ENV T3CODE_TELEMETRY_ENABLED=false
# Optional tool groups (lib/tool-catalog.ts DEFAULT_TOOL_GROUPS): an
# explicit list, so a group added later is never enabled silently. Operators
# remove names, or set `none` for core only, with /app/set environment=.
ENV T3APP_TOOL_GROUPS="capture labs vpn routing dev"
# Provider CLIs to install into the home (lib/providers.ts
# DEFAULT_PROVIDERS): an explicit list, like the groups above. OpenCode, Pi,
# Grok and Muse are opt-in; Cursor and Antigravity come with T3 itself.
ENV T3APP_PROVIDERS="claude codex"
# uv uses the image's Python 3 and never fetches a managed Python by itself;
# `uv python install` still works when asked for explicitly.
ENV UV_PYTHON_DOWNLOADS=manual

ENV SHELL=/bin/bash
# A failed download or checksum grep must fail its pipe, not only the last
# command (hadolint DL4006).
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Browser dependencies for T3 Code's built-in browser, which downloads itself
# on first use. They are core, not an optional group: T3 starts its browser
# itself, so the libraries stay where the system loader finds them.
# `t3 browser setup` cannot run at build time: it needs the browser
# downloaded first and fails on build hosts that restrict user namespaces.
# (Same set as upstream wodby/t3code.)
RUN echo 'Acquire::Retries "10";' > /etc/apt/apt.conf.d/80-retries && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        jq \
        less \
        make \
        openssh-client \
        procps \
        python3 \
        ripgrep \
        unzip \
        fontconfig \
        fonts-liberation \
        libasound2t64 \
        libatk-bridge2.0-0t64 \
        libatk1.0-0t64 \
        libatspi2.0-0t64 \
        libdbus-1-3 \
        libexpat1 \
        libgbm1 \
        libglib2.0-0t64 \
        libnss3 \
        libx11-6 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
# Scope the image's global install to /opt. Runtime Bun installs instead use
# the persistent user's /data/.bun, which precedes these tools on PATH.
RUN ln -s bun /usr/local/bin/bunx && \
    BUN_INSTALL=/opt/bun bun install --global \
        "@tikoci/quickchr@${QUICKCHR_VER}" \
        "@tikoci/centrs@${CENTRS_VER}" && \
    rm -rf /root/.bun/install/cache

# Python bootstrap: uv for project environments, uvx for one-off Python CLIs.
# Tools, caches and venvs land in the home (/data/.local, /data/.cache/uv), so
# they survive image replacement; a uv the user installs in /data/.local/bin
# wins on PATH.
COPY --from=uv /uv /uvx /usr/local/bin/

RUN usermod --home /data --shell /bin/bash node && \
    mkdir -p /data && \
    chown node:node /data

# Release downloads land in /tmp and are removed in the same layer.
WORKDIR /tmp

RUN set -eu; \
    if [ -z "${T3CODE_VER}" ]; then \
      echo "T3CODE_VER is required (example: 0.1.7)"; \
      exit 1; \
    fi; \
    case "${TARGETARCH}" in \
      amd64) arch=x64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "Unsupported architecture ${TARGETARCH}"; exit 1 ;; \
    esac; \
    archive="t3-${T3CODE_VER}-linux-${arch}.tar.gz"; \
    url="https://github.com/pingdotgg/t3code/releases/download/v${T3CODE_VER}"; \
    curl -fsSL --retry 3 -O "${url}/${archive}"; \
    curl -fsSL --retry 3 -O "${url}/SHA256SUMS"; \
    grep -E "[[:space:]]*?${archive}$" SHA256SUMS | sha256sum -c -; \
    mkdir -p /opt/t3code; \
    tar -xzof "${archive}" --strip-components=1 -C /opt/t3code; \
    rm -f "${archive}" SHA256SUMS; \
    ln -s /opt/t3code/t3 /usr/local/bin/t3

# RouterOS pairing help (#18): one <script> tag in the upstream client's
# index.html loads client/routeros-pairing.js, which adds the RouterOS token
# command under T3's pairing form. No other upstream file changes. The script
# fails the build, rather than shipping a pairing screen without the help,
# when the index.html shape or the form's #pairing-token id changes upstream.
COPY client/routeros-pairing.js scripts/install-pairing-help.sh /tmp/pairing-help/
RUN sh /tmp/pairing-help/install-pairing-help.sh /opt/t3code/client /tmp/pairing-help/routeros-pairing.js && \
    rm -rf /tmp/pairing-help

# GitHub CLI: T3's GitHub source-control provider and agents' pull-request
# work need `gh`. Release tarball checked against the release's checksums
# file. Its login (`gh auth login`, or GH_TOKEN) lives in /data/.config/gh.
# Other forges' CLIs (glab, fj/tea, ...) are not bundled; see issue #15.
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64|arm64) ;; \
      *) echo "Unsupported architecture ${TARGETARCH}"; exit 1 ;; \
    esac; \
    name="gh_${GH_VER}_linux_${TARGETARCH}"; \
    url="https://github.com/cli/cli/releases/download/v${GH_VER}"; \
    curl -fsSL --retry 3 -O "${url}/${name}.tar.gz"; \
    curl -fsSL --retry 3 -O "${url}/gh_${GH_VER}_checksums.txt"; \
    grep -E "[[:space:]]${name}\.tar\.gz$" "gh_${GH_VER}_checksums.txt" | sha256sum -c -; \
    tar -xzof "${name}.tar.gz"; \
    install -m 0755 "${name}/bin/gh" /usr/local/bin/gh; \
    rm -rf "${name}" "${name}.tar.gz" "gh_${GH_VER}_checksums.txt"

WORKDIR /

# Core network tools (issue #5 assignment, see README "Network tool
# assignment"), the sqlite3 CLI and zstd (bin/install-claude-code downloads
# Claude's .zst build: about 99 MiB instead of 280). Small user-space clients
# only; capture, VPN and routing peers belong to optional groups. A separate
# late layer keeps the heavy layers above cacheable when this list changes.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        bind9-dnsutils \
        ethtool \
        freeradius-utils \
        iperf3 \
        iproute2 \
        iputils-ping \
        mosquitto-clients \
        mtr-tiny \
        netcat-openbsd \
        snmp \
        socat \
        sqlite3 \
        traceroute \
        whois \
        zstd && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Everything that must survive a restart lives in the home directory on the
# volume: T3 Code's database, agent logins, projects, and tools the user
# installs. Tools installed there with npm or a native installer win over the
# image's copies.
ENV HOME=/data
ENV T3CODE_HOME=/data/.t3
ENV NPM_CONFIG_PREFIX=/data/.local
# Tool-group payload shims (issue #5) follow the user's own installs, so a
# tool the user installed wins; a project's node_modules/.bin wins via npx.
ENV PATH="/data/.local/bin:/data/.bun/bin:/data/.local/share/t3code-tools/bin:/opt/bun/bin:${PATH}"

COPY docker-entrypoint.sh /
COPY bin /usr/local/bin
COPY profile.sh /etc/profile.d/t3code.sh
# lib/ is the shipped runtime (AGENTS.md "Layout"); scripts/ never ships.
COPY lib /usr/local/lib/t3app

# Native tool groups (`capture`, `vpn`, `routing`, `labs`) install as
# Debian-package payloads into the home at runtime, as node. QEMU and its
# firmware are not in the image: `labs` brings them (quickchr stays above).
# Pin each group's dependency closure (whatever this image lacks) by version,
# size and SHA256 from apt's verified indexes now, so a rebuild picks up
# Debian security updates and the payload id follows them.
# Must stay after every apt layer: the closure is computed against them.
# HOME=/root: Bun run as root would otherwise seed a root-owned /data/.bun.
RUN apt-get update && \
    HOME=/root bun /usr/local/lib/t3app/deb-lock.ts && \
    rm -rf /var/lib/apt/lists/*

RUN install -d -o node -g node /usr/share/t3code/inventory

USER node

WORKDIR /data

# Capture the completed image before the entrypoint installs anything into HOME.
RUN bun /usr/local/lib/t3app/image-inventory.ts --output /usr/share/t3code/inventory && \
    t3app tools status --json --groups all > /usr/share/t3code/inventory/tool-groups.json && \
    for lock in /usr/local/lib/t3app/groups/*/debs.lock.json; do \
      group="${lock%/debs.lock.json}"; \
      cp "$lock" "/usr/share/t3code/inventory/${group##*/}-debs.lock.json"; \
    done

VOLUME /data

EXPOSE 3773

# T3 Code runs many agent processes: t3code-init (bash) reaps them and
# forwards signals. Not tini: RouterOS sends SIGTERM only to a PID 1 that has
# a handler installed for it, and SIGKILLs tini at once (#25).
ENTRYPOINT ["/usr/local/bin/t3code-init", "/docker-entrypoint.sh"]

CMD ["t3", "serve"]

# Export inventories for both architectures without loading/running the ARM
# image on the CI host. Keep the default target as the runnable image below.
FROM scratch AS inventory
COPY --from=runtime /usr/share/t3code/inventory/ /

FROM runtime AS final
