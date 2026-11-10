#!/bin/bash
# App entrypoint: prepare the persistent home, start the background tool-group
# and provider installs (into the volume), then exec the server.
set -eu

# RouterOS starts containers with umask 0000 (Docker uses 0022), so everything
# T3, its agents and terminals create in /data would be world-writable.
# Measured on 7.25 / 7.25.1: settings.json 666, project dirs 777.
umask 022

mkdir -p "${HOME}/projects"
cd "${HOME}"

# The image PATH carries the default tool-group shim dir; a relocated payload
# root (T3APP_TOOLS_HOME) needs its own, resolved here at runtime so T3 and
# every agent it starts inherit it. Same slot as profile.d: after the user's
# own installs (/data/.local/bin, /data/.bun/bin), which must keep winning.
if [ -n "${T3APP_TOOLS_HOME:-}" ]; then
	case ":${PATH}:" in
	*:/data/.bun/bin:*) PATH="${PATH/\/data\/.bun\/bin:/\/data\/.bun\/bin:${T3APP_TOOLS_HOME}\/bin:}" ;;
	*:/data/.local/share/t3code-tools/bin:*) PATH="${PATH/\/data\/.local\/share\/t3code-tools\/bin:/${T3APP_TOOLS_HOME}\/bin:\/data\/.local\/share\/t3code-tools\/bin:}" ;;
	*) PATH="${T3APP_TOOLS_HOME}/bin:${PATH}" ;;
	esac
	export PATH
fi

# Background installers log into the home, so a failure outlives an image
# replacement (#13): one directory for all of them. Each start appends (one
# rotation at about 1 MiB). Logging problems never stop T3: an unwritable log
# falls back to the container log.
log_dir="${HOME}/.local/state/t3code"
background() {
	local name="$1" log="${log_dir}/$1.log"
	shift
	if mkdir -p "$log_dir" 2>/dev/null &&
		[ "$(stat -c %s "$log" 2>/dev/null || echo 0)" -gt 1048576 ]; then
		mv -f "$log" "${log}.1" 2>/dev/null || true
	fi
	# Open it for append, as the installer will: a read-only log passes `touch`.
	# Not `>>/dev/stderr` for the fallback: reopening it fails when stderr is a socket.
	if { : >>"$log"; } 2>/dev/null; then
		"$@" >>"$log" 2>&1 &
	else
		echo "t3code: cannot write ${log}; ${name} logs here instead" >&2
		"$@" >&2 &
	fi
}

# t3app (lib/t3app.ts) is the operator command; `init` and
# `install --keep-trying` are its entrypoint-only forms.
# init: name any ignored legacy T3CODE_* keys, report both selections
# (warnings go to the container log), relink tool-group payloads already in
# the home (offline, fast) and write the runtime status JSON. Bounded and
# never fatal: T3 must start whatever the selections say.
# Then the installs run in the background; T3 does not wait. Tool-group
# payloads install while missing; provider CLIs (#13) install while missing
# from PATH (npm into /data/.local, the vendor's installer, or
# install-claude-code, since Claude's license forbids baking it in), and a
# CLI already on PATH is never replaced. --keep-trying: routers often start
# containers before the uplink is up, so these runs retry for about a day
# (`t3app tools install` and `t3app providers install` retry now).
if [ -x /usr/local/bin/t3app ]; then
	timeout 40 /usr/local/bin/t3app init || echo "t3app: init failed; continuing" >&2
	background tool-groups /usr/local/bin/t3app tools install --keep-trying
	background providers /usr/local/bin/t3app providers install --keep-trying
fi

# Pairing hint for the container log (#18). T3 prints its own startup
# pairingUrl too, but with a localhost address the router's browser can't use.
# Keep this command in step with client/routeros-pairing.js (a test checks).
echo 't3code: to pair a browser, open the app URL and run in a RouterOS terminal: :put [/container/shell app-t3code cmd="t3app pairing" as-value]'

if [ -n "${DEBUG:-}" ]; then
	set -x
fi

exec "$@"
