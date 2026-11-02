#!/bin/bash
# App entrypoint: prepare the persistent home, kick off the (volume-local)
# Claude Code install in the background, then exec the server.
set -eu

mkdir -p "${HOME}/projects"
cd "${HOME}"

# Claude Code cannot be baked into the image (license), so install it to the
# volume on first start. Runs in the background; the server does not wait.
if ! command -v claude >/dev/null 2>&1 && [ -x /usr/local/bin/install-claude-code ]; then
	/usr/local/bin/install-claude-code >/tmp/install-claude-code.log 2>&1 &
fi

if [ -n "${DEBUG:-}" ]; then
	set -x
fi

exec "$@"
