#!/bin/bash
# Issue #5 slice 3: apt-metadata download/unpacked sizes of each native group's closure
# against the image, and the bytes + gzip size of the files a baked layer would add.
# Run by docs/research/2026-11-tool-group-payloads/research-capture-bundle.ts --sizes as root in a disposable container.
set -eu
apt-get update -qq >/dev/null 2>&1
for g in "vpn:wireguard-tools strongswan-swanctl strongswan-pki strongswan-charon openvpn sstp-client ppp xl2tpd pppoe ike-scan" "routing:bird2 lldpd ndisc6 arping arp-scan nftables conntrack nmap" "capture-no-tshark:tcpdump nfdump" "tshark-only:tshark"; do
  name=${g%%:*}; pk=${g#*:}
  closure=$(apt-get install -s --no-install-recommends $pk | awk '/^Inst/{print $2"="substr($3,2)}')
  dl=$(for c in $closure; do apt-cache show --no-all-versions "$c" | awk '/^Size:/{print $2; exit}'; done | awk '{s+=$1}END{print s}')
  inst=$(for c in $closure; do apt-cache show --no-all-versions "$c" | awk '/^Installed-Size:/{print $2; exit}'; done | awk '{s+=$1}END{print s*1024}')
  echo "$name packages=$(echo $closure | wc -w) download_bytes=$dl installed_size_meta_bytes=$inst"
done
before=$(mktemp); dpkg-query -W -f='${Package}\n' | sort > $before
for g in "vpn:wireguard-tools strongswan-swanctl strongswan-pki strongswan-charon openvpn sstp-client ppp xl2tpd pppoe ike-scan" "routing:bird2 lldpd ndisc6 arping arp-scan nftables conntrack nmap"; do
  name=${g%%:*}; pk=${g#*:}
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $pk >/dev/null 2>&1
  after=$(mktemp); dpkg-query -W -f='${Package}\n' | sort > $after
  files=$(for p in $(comm -13 $before $after); do dpkg -L $p; done | sort -u | while read -r f; do if [ -f "$f" ] && [ ! -L "$f" ]; then echo "$f"; fi; done)
  echo "$name bake files_bytes=$(echo "$files" | xargs -d '\n' stat -c %s | awk '{s+=$1}END{print s}') layer_gz_bytes=$(echo "$files" | tar -c -T - 2>/dev/null | gzip -6 | wc -c)"
  cp $after $before
done
