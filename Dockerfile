# tikoci/app-t3code — RouterOS /app container for T3 Code.
#
# Rebuilds the wodby/t3code approach from our own Dockerfile so the image we
# ship on GHCR is one we control: Debian trixie-slim (glibc, which the T3 Code
# release binaries need), per-arch t3 tarball from pingdotgg/t3code with
# SHA256 verification, Codex + opencode + Muse Code and Bun/RouterOS tools
# baked in, Claude Code installed to the volume on first boot (license
# forbids redistribution).
#
# Build:
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     --build-arg T3CODE_VER=0.1.6 -t ghcr.io/tikoci/app-t3code:0.1 .
# Run (plain HTTP on 3773; terminate TLS in front for remote use):
#   docker run -p 3773:3773 -v t3code:/data -e PUBLIC_URL=https://t3.example.com ghcr.io/tikoci/app-t3code:0.1

ARG NODE_VER=24
ARG BUN_VER=1.4.4

FROM oven/bun:${BUN_VER}-slim AS bun

FROM node:${NODE_VER}-trixie-slim AS runtime

ARG TARGETARCH
ARG T3CODE_VER=0.1.6
ARG CODEX_VER=latest
ARG OPENCODE_VER=latest
ARG QUICKCHR_VER=next
ARG CENTRS_VER=next

ENV T3CODE_VER="${T3CODE_VER}"
ENV T3CODE_HOST=0.0.0.0
ENV T3CODE_PORT=3773
# RouterOS `/app/set environment=` replaces the whole env list, so anything
# the /app YAML sets must also be an image default here (issue #5).
ENV T3CODE_TELEMETRY_ENABLED=false

ENV SHELL=/bin/bash

# Browser dependencies for T3 Code's built-in browser, which downloads itself
# on first use. `t3 browser setup` cannot run at build time: it needs the
# browser downloaded first and fails on build hosts that restrict user
# namespaces. (Same set as upstream wodby/t3code.)
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
        qemu-system-x86 \
        qemu-system-arm \
        qemu-efi-aarch64 \
        qemu-utils \
        ripgrep \
        tini \
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

# Meta's official installer verifies the platform binary's size and SHA256.
# Ship that native binary directly: updates arrive with image replacements,
# rather than a launcher trying to modify root-owned image files at runtime.
RUN curl -fsSL --retry 3 https://dev.meta.ai/install.sh -o /tmp/install-muse.sh && \
    MUSE_INSTALL_DIR=/opt/muse MUSE_LOGIN=0 MUSE_UPGRADE_MODE=1 bash /tmp/install-muse.sh && \
    install -m 0755 "/opt/muse/muse-bin-$(cat /opt/muse/.muse-version)" /usr/local/bin/muse && \
    rm -rf /opt/muse /tmp/install-muse.sh

RUN usermod --home /data --shell /bin/bash node && \
    mkdir -p /data && \
    chown node:node /data

RUN set -eu; \
    if [ -z "${T3CODE_VER}" ]; then \
      echo "T3CODE_VER is required (example: 0.1.6)"; \
      exit 1; \
    fi; \
    case "${TARGETARCH}" in \
      amd64) arch=x64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "Unsupported architecture ${TARGETARCH}"; exit 1 ;; \
    esac; \
    archive="t3-${T3CODE_VER}-linux-${arch}.tar.gz"; \
    url="https://github.com/pingdotgg/t3code/releases/download/v${T3CODE_VER}"; \
    cd /tmp; \
    curl -fsSL --retry 3 -O "${url}/${archive}"; \
    curl -fsSL --retry 3 -O "${url}/SHA256SUMS"; \
    grep -E "[[:space:]]*?${archive}$" SHA256SUMS | sha256sum -c -; \
    mkdir -p /opt/t3code; \
    tar -xzof "${archive}" --strip-components=1 -C /opt/t3code; \
    rm -f "${archive}" SHA256SUMS; \
    ln -s /opt/t3code/t3 /usr/local/bin/t3

# Agent CLIs baked into the image. Claude Code is intentionally absent here:
# its license does not allow redistribution, so the entrypoint installs it to
# the persistent volume on first start instead.
RUN npm install -g --no-fund --no-audit \
        "@openai/codex@${CODEX_VER}" \
        "opencode-ai@${OPENCODE_VER}" && \
    npm cache clean --force

# Core network tools (issue #5 assignment, see README "Network tool
# assignment"). Small user-space clients only; capture, VPN and routing peers
# belong to optional groups. A separate late layer keeps the heavy layers
# above cacheable when this list changes.
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
        traceroute \
        whois && \
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
COPY scripts/image-inventory.ts scripts/tool-groups.ts scripts/tool-payloads.ts /usr/local/lib/t3code/
COPY scripts/groups /usr/local/lib/t3code/groups

RUN install -d -o node -g node /usr/share/t3code/inventory

USER node

WORKDIR /data

# Capture the completed image before the entrypoint installs anything into HOME.
RUN bun /usr/local/lib/t3code/image-inventory.ts --output /usr/share/t3code/inventory && \
    t3code-tools status --json --groups all > /usr/share/t3code/inventory/tool-groups.json

VOLUME /data

EXPOSE 3773

# T3 Code runs many agent processes: tini reaps them and forwards signals.
ENTRYPOINT ["/usr/bin/tini", "--", "/docker-entrypoint.sh"]

CMD ["t3", "serve"]

# Export inventories for both architectures without loading/running the ARM
# image on the CI host. Keep the default target as the runnable image below.
FROM scratch AS inventory
COPY --from=runtime /usr/share/t3code/inventory/ /

FROM runtime AS final
