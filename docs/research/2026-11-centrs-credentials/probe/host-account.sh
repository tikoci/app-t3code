#!/bin/bash
# Credentials research: switch the host record in the encrypted CDB from
# admin to the router-made account t3code, whose password is the same
# /run/secrets value. Then read, and try one write the group must refuse.
# The write runs only if the switch worked and the read authenticated as
# t3code (guards added after the 2026-11-25 run, which passed both).
sum() { jq -c '{ok, data: (.data|tostring|.[0:60]), err: .error.code, user: .meta.operation.auth.username,
  src: ((.meta.settings // {}) | {username: .username.kind, password: .password.kind})}'; }
h=$(awk '$2=="00000000"{print $3; exit}' /proc/net/route)
GW=$(printf '%d.%d.%d.%d' "0x${h:6:2}" "0x${h:4:2}" "0x${h:2:2}" "0x${h:0:2}")
CENTRS_CDB_PASSWORD=$(cat /run/secrets/routeros_pw)
export CENTRS_CDB_PASSWORD
set_out=$(printf %s "$CENTRS_CDB_PASSWORD" | centrs devices set "$GW" --user t3code --password-stdin --json)
jq -c '{ok, err: .error.code, msg: .error.message}' <<< "$set_out"
jq -e '.ok == true' <<< "$set_out" > /dev/null || { echo "devices set failed; skipping the write test" >&2; exit 1; }
echo "== read as t3code"; read_out=$(centrs retrieve "$GW" /system/identity --json); sum <<< "$read_out"
jq -e '.meta.operation.auth.username == "t3code"' <<< "$read_out" > /dev/null || { echo "host does not authenticate as t3code; skipping the write test" >&2; exit 1; }
echo "== write as t3code (should fail)"
centrs execute "$GW" --yes '/system/identity/set name=changed' --json | sum
