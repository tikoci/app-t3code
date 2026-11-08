#!/bin/sh
# install-pairing-help.sh <client-dir> <helper.js>
# Adds the RouterOS pairing help (#18) to T3 Code's shipped web client: copies
# the helper next to index.html and inserts one <script> tag before </head>.
# Fails, rather than shipping a pairing screen without the help, when the
# upstream index.html or the token form's #pairing-token id changes shape.
# Counts occurrences, not lines: minified HTML can hold several on one line.
set -eu

client="$1"
helper="$2"
index="${client}/index.html"
tag='<script defer src="/routeros-pairing.js"></script>'

count() { grep -oF "$1" "$2" | wc -l | tr -d ' '; }

[ "$(count '</head>' "$index")" = 1 ] || {
	echo "pairing help: expected exactly one </head> in $index" >&2
	exit 1
}
[ "$(count "$tag" "$index")" = 0 ] || {
	echo "pairing help: $index already loads routeros-pairing.js" >&2
	exit 1
}
# The token input's id prop in the minified bundle (id:`pairing-token` in
# 0.1.7, any quote style). A bare "pairing-token" is not enough: the bundle
# also has the unrelated /api/auth/pairing-token path. grep -l over the glob:
# a missing assets dir leaves the glob literal, and grep then fails like a
# missing match.
grep -lqE 'id:[^[:alnum:]]pairing-token[^[:alnum:]-]' "${client}"/assets/*.js 2>/dev/null || {
	echo "pairing help: the #pairing-token input is not in the T3 web bundle; recheck PairingRouteSurface.tsx" >&2
	exit 1
}

cp "$helper" "${client}/routeros-pairing.js"
# awk + mv rather than sed -i: BSD sed (macOS, where `bun run test` runs this
# too) takes -i differently and has no \n in replacements.
awk -v tag="$tag" '!done && sub(/<\/head>/, "  " tag "\n  </head>") { done = 1 } { print }' "$index" >"${index}.tmp"
mv "${index}.tmp" "$index"
[ "$(count "$tag" "$index")" = 1 ] || {
	echo "pairing help: script tag not inserted exactly once" >&2
	exit 1
}
