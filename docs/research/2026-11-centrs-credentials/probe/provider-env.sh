#!/bin/bash
# Credentials research: which running processes carry LAB_PROBE_ENV (set as a
# Codex provider-instance environment variable in T3's settings.json) and
# LAB_ROUTER (set in the container env, so inherited from the T3 server).
# Prints PIDs, process names (comm) and marker counts, never command lines.
for p in /proc/[0-9]*; do
  e=$(tr '\0' '\n' < "$p/environ" 2>/dev/null) || continue
  a=$(grep -c '^LAB_PROBE_ENV=' <<< "$e"); b=$(grep -c '^LAB_ROUTER=' <<< "$e")
  [ "$a$b" = "00" ] && continue
  echo "pid $(basename "$p") probe=$a router=$b comm=$(cat "$p/comm" 2>/dev/null)"
done
# Names and flags only, never an environment value.
echo "settings providerInstances: $(jq -c '(.providerInstances // {}) | map_values({driver, environment: [(.environment // [])[] | {name, sensitive}]})' /data/.t3/userdata/settings.json 2>/dev/null)"
