#!/bin/bash
# Credentials research: run by the agent itself, from its own shell tool in a
# T3 session (not through /container/shell). Reports, for this shell, whether
# each marker is present (zeros included) and the parent chain (process names
# from comm and parent IDs, never command lines, which could hold a value), so
# the result shows which process the environment came through. Prints no values.
for v in LAB_ROUTER LAB_PROBE_ENV CENTRS_CDB_PASSWORD CENTRS_CDB_PASSWORD_FILE; do
  if [ -n "${!v+x}" ]; then echo "$v=present"; else echo "$v=absent"; fi
done
pid=$$
while :; do
  ppid=$(awk '/^PPid:/{print $2}' "/proc/$pid/status" 2>/dev/null)
  echo "pid=$pid ppid=${ppid:-?} comm=$(cat "/proc/$pid/comm" 2>/dev/null)"
  [ -z "$ppid" ] || [ "$ppid" -le 1 ] && break
  pid=$ppid
done
