#!/bin/bash
# Credentials research: sample processes for ~330 s (past T3's 300 s provider
# re-probe) and record, once per pid, whether a codex-related process carries
# LAB_PROBE_ENV (provider-instance env) and LAB_ROUTER (T3's own env).
out=/tmp/env-sampler.out; : > "$out"; seen=" "
end=$((SECONDS + 330))
while [ "$SECONDS" -lt "$end" ]; do
  for p in /proc/[0-9]*; do
    pid=${p#/proc/}
    case "$seen" in *" $pid "*) continue ;; esac
    cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null) || continue
    case "$cmd" in *codex*) ;; *) continue ;; esac
    e=$(tr '\0' '\n' < "$p/environ" 2>/dev/null) || continue
    seen="$seen$pid "
    echo "$(date -u +%T) pid=$pid probe=$(grep -c '^LAB_PROBE_ENV=' <<< "$e") router=$(grep -c '^LAB_ROUTER=' <<< "$e") ${cmd:0:90}" >> "$out"
  done
  sleep 0.2
done
echo "finished" >> "$out"
