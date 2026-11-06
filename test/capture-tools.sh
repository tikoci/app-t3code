#!/bin/bash
# Functional check of the `capture` payload inside the container, run by
# test/container-replacement.test.ts as node with no capabilities: offline
# decoding with the payload's own data and plugin paths, capture-file tools,
# an unprivileged NetFlow collector, and live capture refused rather than
# granted. The fixture is TZSP_DNS_PCAPNG from scripts/tool-groups.ts.
set -euo pipefail
cd /tmp
fixture=/tmp/capture-fixture.pcapng
printf %s 'Cg0NChwAAABNPCsaAQAAAP//////////HAAAAAEAAAAUAAAAAQAAAP//AAAUAAAABgAAAJwAAAAAAAAAAAAAAEBCDwB7AAAAewAAAAIAAAAAAgIAAAAAAQgARQAAbQAAAABAEfZ8wAACAcAAAgKn+JCQAFkAAAEAAAEBAgAAAAACAgAAAAABCABFAAA+AAAAAEAR9qvAAAIBwAACAjA5ADUAKgAAEjQBAAABAAAAAAAACHJvdXRlcm9zB2V4YW1wbGUAAAEAAQCcAAAA' | base64 -d >"$fixture"

# Tools come from the payload shims, not the image, with no global library path.
test "$(command -v tshark)" = "${T3CODE_TOOLS_HOME:-/data/.local/share/t3code-tools}/bin/tshark"
test ! -e /usr/bin/tshark
test -z "${LD_LIBRARY_PATH:-}"

test "$(tshark -r "$fixture" -T fields -e tzsp.encap -e dns.qry.name)" = "$(printf '1\trouteros.example')"
tshark -G folders | grep -q 'Global configuration:.*/groups/capture/.*/root/usr/share/wireshark'
tshark -G folders | grep -q 'Global Plugins:.*/groups/capture/.*/wireshark/plugins/'
test "$(tshark -G plugins | wc -l)" -gt 10
tcpdump -nr "$fixture" 2>/dev/null | grep -q '192.0.2.1.43000 > 192.0.2.2.37008: UDP'
editcap -F pcap "$fixture" /tmp/capture-fixture.pcap
mergecap -w /tmp/capture-merged.pcapng "$fixture" /tmp/capture-fixture.pcap
capinfos -c /tmp/capture-merged.pcapng | grep -Eq 'Number of packets: +2'
tshark -r "$fixture" -x | text2pcap -q - /tmp/capture-text.pcap
tshark -r /tmp/capture-text.pcap -T fields -e dns.qry.name | grep -qx routeros.example

# Listing interfaces needs no privilege; capturing does, and is refused.
# CAPTURE_TOOLS_QEMU_USER=1 skips the interface listing, whose ethtool ioctl
# QEMU user-mode emulation does not implement (arm64 runs on an amd64 host).
if [ -z "${CAPTURE_TOOLS_QEMU_USER:-}" ]; then dumpcap -D | grep -q 'lo'; fi
if timeout 10 dumpcap -i lo -c 1 -a duration:2 -w /tmp/capture-live.pcapng 2>/dev/null; then echo "dumpcap captured without CAP_NET_RAW" >&2; exit 1; fi
if timeout 10 tcpdump -i lo -c 1 2>/dev/null; then echo "tcpdump captured without CAP_NET_RAW" >&2; exit 1; fi

# NetFlow v5 collector on an unprivileged port: one record, 192.0.2.1 -> 192.0.2.2 udp/53, 5 packets, 500 bytes.
rm -rf /tmp/capture-nf && mkdir /tmp/capture-nf
nfcapd -w /tmp/capture-nf -p 9995 -t 60 >/dev/null 2>&1 &
nf=$!
sleep 1
printf '\x00\x05\x00\x01\x00\x00\x10\x00\x65\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\xc0\x00\x02\x01\xc0\x00\x02\x02\x00\x00\x00\x00\x00\x01\x00\x02\x00\x00\x00\x05\x00\x00\x01\xf4\x00\x00\x01\x00\x00\x00\x0f\x00\xa7\xf8\x00\x35\x00\x00\x11\x00\x00\x00\x00\x00\x18\x18\x00\x00' >/dev/udp/127.0.0.1/9995
sleep 1
kill -TERM "$nf"
wait "$nf" || true
nfdump -R /tmp/capture-nf -q -o 'fmt:%sa %da %dp %pkt %byt' | grep -Eq '192\.0\.2\.1 +192\.0\.2\.2 +53 +5 +500'
echo "capture ok: $(tshark --version | head -1); $(tcpdump --version 2>&1 | head -1); $(nfdump -V)"
