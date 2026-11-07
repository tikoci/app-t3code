#!/bin/bash
# App entrypoint: prepare the persistent home, kick off the (volume-local)
# Claude Code install in the background, then exec the server.
set -eu

mkdir -p "${HOME}/projects"
cd "${HOME}"

# The image PATH carries the default tool-group shim dir; a relocated payload
# root (T3CODE_TOOLS_HOME) needs its own, resolved here at runtime so T3 and
# every agent it starts inherit it. Same slot as profile.d: after the user's
# own installs (/data/.local/bin, /data/.bun/bin), which must keep winning.
if [ -n "${T3CODE_TOOLS_HOME:-}" ]; then
	case ":${PATH}:" in
	*:/data/.bun/bin:*) PATH="${PATH/\/data\/.bun\/bin:/\/data\/.bun\/bin:${T3CODE_TOOLS_HOME}\/bin:}" ;;
	*:/data/.local/share/t3code-tools/bin:*) PATH="${PATH/\/data\/.local\/share\/t3code-tools\/bin:/${T3CODE_TOOLS_HOME}\/bin:\/data\/.local\/share\/t3code-tools\/bin:}" ;;
	*) PATH="${T3CODE_TOOLS_HOME}/bin:${PATH}" ;;
	esac
	export PATH
fi

# Report the T3CODE_TOOL_GROUPS selection (warnings go to the container log),
# relink tool-group payloads already in the home (offline, fast) and write the
# runtime status JSON. Bounded and never fatal: T3 must start whatever the
# selection says. Missing payloads install in the background; T3 does not wait.
# --keep-trying: routers often start containers before the uplink is up, so
# the background run retries for about a day (`t3code-tools install` from a
# terminal retries now).
if [ -x /usr/local/bin/t3code-tools ]; then
	timeout 20 /usr/local/bin/t3code-tools init || echo "t3code-tools: init failed; continuing" >&2
	/usr/local/bin/t3code-tools install --keep-trying >/tmp/t3code-tools-install.log 2>&1 &
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
