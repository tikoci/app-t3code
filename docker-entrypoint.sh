#!/bin/bash
# App entrypoint: prepare the persistent home, kick off the (volume-local)
# Claude Code install in the background, then exec the server.
set -eu

mkdir -p "${HOME}/projects"
cd "${HOME}"

# The image PATH carries the default tool-group shim dir; a relocated payload
# root (T3CODE_TOOLS_HOME) needs its own, resolved here at runtime so T3 and
# every agent it starts inherit it. Login shells get it from profile.d.
if [ -n "${T3CODE_TOOLS_HOME:-}" ]; then
	export PATH="${T3CODE_TOOLS_HOME}/bin:${PATH}"
fi

# Report the T3CODE_TOOL_GROUPS selection (warnings go to the container log),
# relink tool-group payloads already in the home (offline, fast) and write the
# runtime status JSON. Bounded and never fatal: T3 must start whatever the
# selection says. Missing payloads install in the background; T3 does not wait.
if [ -x /usr/local/bin/t3code-tools ]; then
	timeout 20 /usr/local/bin/t3code-tools init || echo "t3code-tools: init failed; continuing" >&2
	/usr/local/bin/t3code-tools install >/tmp/t3code-tools-install.log 2>&1 &
fi

# Claude Code cannot be baked into the image (license), so install it to the
# volume on first start. Runs in the background; the server does not wait.
if ! command -v claude >/dev/null 2>&1 && [ -x /usr/local/bin/install-claude-code ]; then
	/usr/local/bin/install-claude-code >/tmp/install-claude-code.log 2>&1 &
fi

if [ -n "${DEBUG:-}" ]; then
	set -x
fi

exec "$@"
