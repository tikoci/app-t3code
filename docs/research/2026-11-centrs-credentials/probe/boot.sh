# Runs at every container start (the probe app's command). Appends one
# record to /data/boots. Records the secret only as length + sha256, so the
# log shows same/different without the value.
{
  echo "=== boot $(date -u +%FT%TZ)"
  env | grep '^P_' | sed 's/^\(P_[A-Z_]*SECRET[A-Z_]*=\).*/\1<redacted>/'
  if [ -n "$P_SECRET_ENV" ]; then
    echo "P_SECRET_ENV len=${#P_SECRET_ENV} sha=$(printf %s "$P_SECRET_ENV" | sha256sum | cut -c1-12)"
  fi
  ls -ln /run/secrets 2>&1
  for f in /run/secrets/*; do
    [ -f "$f" ] && echo "$f len=$(wc -c < "$f") sha=$(sha256sum < "$f" | cut -c1-12)"
  done
  echo "id: $(id)"
  ip -4 addr show | grep inet
  ip -4 route
  GW=$(ip -4 route | awk '/^default/{print $3}')
  for t in "$GW" "$P_NET_ROUTER_IP" "$P_ROUTER_IP"; do
    [ -z "$t" ] && continue
    for p in 22 80 443 8728 8729; do
      if nc -z -w 3 "$t" "$p" 2>/dev/null; then echo "tcp $t:$p open"; else echo "tcp $t:$p closed"; fi
    done
    echo "rest $t admin/empty: $(wget -q -T 5 -O- "http://admin:@$t/rest/system/identity" 2>&1 | head -c 200)"
  done
} >> /data/boots 2>&1
