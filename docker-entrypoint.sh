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
# volume while no `claude` is on PATH. Runs in the background and retries for
# about a day; the server does not wait. The log stays in the home so a
# failure outlives an image replacement (#13): each start appends (one
# rotation at about 1 MiB). Logging problems never stop T3: an unwritable
# log falls back to the container log.
if ! command -v claude >/dev/null 2>&1 && [ -x /usr/local/bin/install-claude-code ]; then
	claude_log="${HOME}/.local/state/t3code/install-claude-code.log"
	if mkdir -p "${claude_log%/*}" 2>/dev/null &&
		[ "$(stat -c %s "$claude_log" 2>/dev/null || echo 0)" -gt 1048576 ]; then
		mv -f "$claude_log" "${claude_log}.1" 2>/dev/null || true
	fi
	# Open it for append, as the installer will: a read-only log passes `touch`.
	if ! { : >>"$claude_log"; } 2>/dev/null; then
		echo "t3code: cannot write ${claude_log}; the Claude install logs here instead" >&2
		claude_log=""
	fi
	# Not `>>/dev/stderr`: reopening it fails when stderr is a socket.
	if [ -n "$claude_log" ]; then
		/usr/local/bin/install-claude-code --keep-trying >>"$claude_log" 2>&1 &
	else
		/usr/local/bin/install-claude-code --keep-trying >&2 &
	fi
fi

# Pairing hint for the container log (#18). T3 prints its own startup
# pairingUrl too, but with a localhost address the router's browser can't use.
# Keep this command in step with client/routeros-pairing.js (a test checks).
echo 't3code: to pair a browser, open the app URL and run in a RouterOS terminal: :put [/container/shell app-t3code cmd="t3-pairing-link" as-value]'

if [ -n "${DEBUG:-}" ]; then
	set -x
fi

exec "$@"
