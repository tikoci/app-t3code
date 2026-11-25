#!/bin/bash
# Credentials research: run by the agent itself, from its own shell tool in a
# T3 session (not through /container/shell). Reports, for this shell, whether
# each marker is present (zeros included) and the parent chain, so the result
# shows which process the environment came through. Prints no values.
for v in LAB_ROUTER LAB_PROBE_ENV CENTRS_CDB_PASSWORD CENTRS_CDB_PASSWORD_FILE; do
  if [ -n "${!v+x}" ]; then echo "$v=present"; else echo "$v=absent"; fi
done
pid=$$
while [ "$pid" -gt 1 ] 2>/dev/null; do
  echo "pid=$pid $(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-90)"
  pid=$(awk '/^PPid:/{print $2}' "/proc/$pid/status" 2>/dev/null)
done
echo "pid=1 $(tr '\0' ' ' < /proc/1/cmdline 2>/dev/null | cut -c1-90)"
