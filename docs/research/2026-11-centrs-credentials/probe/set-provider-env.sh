#!/bin/bash
# Credentials research: give the Codex provider instance one plain (not
# sensitive) environment variable through T3's settings.json.
s=/data/.t3/userdata/settings.json
[ -f "$s" ] || echo '{}' > "$s"
jq '.providerInstances.codex = ((.providerInstances.codex // {driver: "codex"})
  + {environment: [{name: "LAB_PROBE_ENV", value: "from-settings", sensitive: false}]})' "$s" > "$s.new" && mv "$s.new" "$s"
chmod 600 "$s"; jq -c .providerInstances "$s"
