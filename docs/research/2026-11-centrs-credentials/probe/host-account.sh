#!/bin/bash
# Credentials research: switch the host record in the encrypted CDB from
# admin to the router-made account t3code, whose password is the same
# /run/secrets value. Then read, and try one write the group must refuse.
sum() { jq -c '{ok, data: (.data|tostring|.[0:60]), err: .error.code, user: .meta.operation.auth.username,
  src: ((.meta.settings // {}) | {username: .username.kind, password: .password.kind})}'; }
GW=172.18.0.1
CENTRS_CDB_PASSWORD=$(cat /run/secrets/routeros_pw)
export CENTRS_CDB_PASSWORD
printf %s "$CENTRS_CDB_PASSWORD" | centrs devices set "$GW" --user t3code --password-stdin --json | jq -c '{ok, err: .error.code, msg: .error.message}'
echo "== read as t3code"; centrs retrieve "$GW" /system/identity --json | sum
echo "== write as t3code (should fail)"
centrs execute "$GW" --yes '/system/identity/set name=changed' --json | sum
