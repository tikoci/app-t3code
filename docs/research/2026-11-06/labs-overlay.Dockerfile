FROM app-t3code:pr10-review
USER root
# Emulates the slice-5 first apt layer, which no longer installs QEMU.
RUN DEBIAN_FRONTEND=noninteractive apt-get purge -y qemu-system-x86 qemu-system-arm qemu-efi-aarch64 qemu-utils && DEBIAN_FRONTEND=noninteractive apt-get autoremove --purge -y && rm -rf /var/lib/apt/lists/*
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
COPY scripts/image-inventory.ts scripts/tool-groups.ts scripts/tool-payloads.ts scripts/deb-payloads.ts /usr/local/lib/t3code/
COPY scripts/groups /usr/local/lib/t3code/groups

# Native tool groups (`capture`, `vpn`, `routing`, `labs`) install as
# Debian-package payloads into the home at runtime, as node. QEMU and its
# firmware are not in the image: `labs` brings them (quickchr stays above). Pin each group's dependency closure (whatever this
# image lacks) by version, size and SHA256 from apt's verified indexes now, so
# a rebuild picks up Debian security updates and the payload id follows them.
# Must stay after every apt layer: the closure is computed against them.
# HOME=/root: Bun run as root would otherwise seed a root-owned /data/.bun.
RUN apt-get update && \
    HOME=/root t3code-tools deb-lock && \
    rm -rf /var/lib/apt/lists/*

RUN install -d -o node -g node /usr/share/t3code/inventory

USER node

WORKDIR /data

# Capture the completed image before the entrypoint installs anything into HOME.
RUN bun /usr/local/lib/t3code/image-inventory.ts --output /usr/share/t3code/inventory && \
    t3code-tools status --json --groups all > /usr/share/t3code/inventory/tool-groups.json && \
    for lock in /usr/local/lib/t3code/groups/*/debs.lock.json; do \
      group="${lock%/debs.lock.json}"; \
      cp "$lock" "/usr/share/t3code/inventory/${group##*/}-debs.lock.json"; \
    done

VOLUME /data

EXPOSE 3773

# T3 Code runs many agent processes: tini reaps them and forwards signals.
ENTRYPOINT ["/usr/bin/tini", "--", "/docker-entrypoint.sh"]

CMD ["t3", "serve"]

# Export inventories for both architectures without loading/running the ARM
# image on the CI host. Keep the default target as the runnable image below.
