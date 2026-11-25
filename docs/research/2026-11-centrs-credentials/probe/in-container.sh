#!/bin/bash
# Credentials research, run inside the app-t3code container as node through
# /container/shell. Prints no secret values: lengths, sources and outcomes only.
# Upload to the container's /tmp (see ../README.md "Reproduce").
sum() { jq -c '{ok, data: (.data|tostring|.[0:60]), err: .error.code,
  user: .meta.operation.auth.username, pw: .meta.operation.auth.passwordProvided,
  src: ((.meta.settings // {}) | {host: .host.kind, username: .username.kind, password: .password.kind})}'; }

echo "== id: $(id)"
echo "== /run/secrets"; ls -ln /run/secrets
f=/run/secrets/routeros_pw
[ -r "$f" ] && echo "readable by $(id -un), len $(wc -c < "$f")"
echo "== env: LAB_ROUTER=${LAB_ROUTER:-unset}; env lines naming the secret: $(env | grep -ci routeros_pw)"
env | grep '^CENTRS_' | sed 's/=.*/=<set>/'
h=$(awk '$2=="00000000"{print $3; exit}' /proc/net/route)
GW=$(printf '%d.%d.%d.%d' "0x${h:6:2}" "0x${h:4:2}" "0x${h:2:2}" "0x${h:0:2}")
echo "== gateway from /proc/net/route: $GW"

echo "== 1 CENTRS_HOST only"; CENTRS_HOST=$LAB_ROUTER centrs retrieve /system/identity --json | sum
echo "== 2 positional, no creds"; centrs retrieve "$LAB_ROUTER" /system/identity --json | sum
echo "== 3 env admin + empty password"
CENTRS_USERNAME=admin CENTRS_PASSWORD='' centrs retrieve "$LAB_ROUTER" /system/identity --json | sum

K=$(cat "$f")
echo "== 4 encrypted CDB init, key from /run/secrets (via env, not argv)"
CENTRS_CDB_PASSWORD=$K centrs devices init --encrypt --json | jq -c '{ok, err: .error.code, data: (.data | {cdbFile, encrypted, changed})}'
echo "== 5 __default__ = admin, empty password"
CENTRS_CDB_PASSWORD=$K centrs devices add __default__ --user admin --password '' --json | jq -c '{ok, err: .error.code, msg: .error.message}'
echo "== 6 host record"
CENTRS_CDB_PASSWORD=$K centrs devices add "$GW" --group host --json | jq -c '{ok, err: .error.code, msg: .error.message}'
echo "== 7 retrieve host with CDB key"; CENTRS_CDB_PASSWORD=$K centrs retrieve "$GW" /system/identity --json | sum
echo "== 8 retrieve host without CDB key"; centrs retrieve "$GW" /system/identity --json | sum
echo "== 9 list without CDB key"; centrs devices list --json | jq -c '{ok, err: .error.code}'
c=$HOME/.config/tikoci/winbox.cdb
echo "== 10 CDB file"; ls -ln "$c"; echo "plaintext 'admin' occurrences: $(grep -c -a admin "$c")"
