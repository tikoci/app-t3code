#!/bin/bash
# Functional check of the `routing` payload inside the container, run by
# test/container-replacement.test.ts as node with no capabilities: two BIRD
# instances exchange a prefix over eBGP on unprivileged ports, nmap finds its
# NSE scripts and service names relative to the binary, and the probes that
# need privileges are refused rather than granted.
set -euo pipefail
rm -rf /tmp/routing-check && mkdir /tmp/routing-check && cd /tmp/routing-check

# A probe that needs a privilege must be refused with a permission error:
# success, a timeout or any other failure fails the check. A bare "root"
# is not enough: the payload path itself contains /root/.
refused() {
	local name=$1 out rc
	shift
	set +e
	out=$(timeout 10 "$@" 2>&1)
	rc=$?
	set -e
	if [ "$rc" -eq 0 ]; then echo "$name succeeded without privileges" >&2; exit 1; fi
	if [ "$rc" -eq 124 ]; then echo "$name timed out instead of being refused" >&2; exit 1; fi
	if ! grep -Eqi 'permission|not permitted|requires root|must be root|CAP_NET_(RAW|ADMIN)' <<<"$out"; then echo "$name failed for another reason (exit $rc): $out" >&2; exit 1; fi
}

tools=${T3APP_TOOLS_HOME:-/data/.local/share/t3code-tools}/bin
for c in bird birdc rdisc6 arping arp-scan nft conntrack nmap; do test "$(command -v "$c")" = "$tools/$c"; done
test ! -e /usr/sbin/bird && test ! -e /usr/bin/nmap
test -z "${LD_LIBRARY_PATH:-}"

# eBGP between 127.0.0.1 AS65001 and 127.0.0.2 AS65002, ports 11791/11792.
# Cleanup is armed before either daemon starts and waits for both to exit,
# so a failed second start or a rerun never finds a stale BIRD on the ports.
stop() {
	local pid
	for n in 1 2; do
		pid=$(cat "/tmp/routing-check/bird$n.pid" 2>/dev/null) || continue
		kill "$pid" 2>/dev/null || continue
		for _ in $(seq 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
	done
}
trap stop EXIT
for n in 1 2; do
	o=$((3 - n))
	cat >"bird$n.conf" <<CONF
router id 192.0.2.$n;
protocol device {}
protocol direct { ipv4; interface "lo"; }
protocol static { ipv4; route 198.51.100.$n/32 blackhole; }
protocol bgp peer {
	local 127.0.0.$n port 1179$n as 6500$n;
	neighbor 127.0.0.$o port 1179$o as 6500$o;
	multihop;
	ipv4 { import all; export where source = RTS_STATIC; next hop self; };
}
CONF
	bird -p -c "bird$n.conf"
	bird -c "bird$n.conf" -s "/tmp/routing-check/bird$n.ctl" -P "/tmp/routing-check/bird$n.pid"
done
for _ in $(seq 30); do
	grep -q '1 imported' <<<"$(birdc -s bird1.ctl show protocols all peer)" && break
	sleep 1
done
grep -q 'BGP state: *Established' <<<"$(birdc -s bird1.ctl show protocols all peer)"
grep -q 'BGP.as_path: 65002' <<<"$(birdc -s bird1.ctl show route 198.51.100.2/32 all)"

# nmap: data files from ../share/nmap next to the binary (no NMAPDIR), a
# connect scan without privileges, and a raw scan refused.
test -z "${NMAPDIR:-}"
grep -q 'Categories: discovery safe' <<<"$(nmap --script-help banner)"
# BIRD 1 is still listening on 11791.
grep -Eq '^11791/tcp +open ' <<<"$(nmap -sT -p 11791 -Pn 127.0.0.1)"
refused "nmap -sS" nmap -sS -p 1 127.0.0.1

# arp-scan's vendor files come from the payload through its wrapper: decode
# an ARP reply from a MikroTik OUI out of a capture (ARP_REPLY_PCAP in
# lib/tool-catalog.ts), no interface or privilege needed. A later
# --ouifile from the caller still wins over the wrapper's.
printf %s '1MOyoQIABAAAAAAAAAAAAP//AAABAAAAAAAAAAAAAAA8AAAAPAAAAAIAAAAAAUxeDBEiMwgGAAEIAAYEAAJMXgwRIjPAAAIBAgAAAAABwAACAgAAAAAAAAAAAAAAAAAAAAAAAA==' | base64 -d >arp-reply.pcap
arp_out=$(arp-scan --readpktfromfile=arp-reply.pcap 192.0.2.1 2>&1)
grep -Eq '^192\.0\.2\.1	4c:5e:0c:11:22:33	Routerboard\.com' <<<"$arp_out"
if grep -q 'Cannot open MAC/Vendor file' <<<"$arp_out"; then echo "arp-scan missed its vendor files: $arp_out" >&2; exit 1; fi
grep -q 'Cannot open MAC/Vendor file /nonexistent.txt' <<<"$(arp-scan --ouifile=/nonexistent.txt --readpktfromfile=arp-reply.pcap 192.0.2.1 2>&1)"

# These need CAP_NET_ADMIN or CAP_NET_RAW: refused with a permission error.
# ROUTING_TOOLS_QEMU_USER=1 skips them: QEMU user-mode emulation (arm64 on an
# amd64 host) has no netfilter netlink, so they fail before any permission check.
if [ -z "${ROUTING_TOOLS_QEMU_USER:-}" ]; then
	printf 'table inet t { chain c { type filter hook input priority 0; tcp dport 22 accept; }; }\n' >rules.nft
	refused nft nft -c -f rules.nft
	refused conntrack conntrack -L
	refused arping arping -c 1 -i lo 127.0.0.1
	refused arp-scan arp-scan -I lo 127.0.0.1
fi

grep -q 'ndisc6' <<<"$(rdisc6 -V)"

echo "routing ok: $(bird --version 2>&1); $(nmap --version | head -1)"
