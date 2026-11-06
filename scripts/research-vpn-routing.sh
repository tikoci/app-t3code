#!/bin/bash
# Issue #5 slice 4: relocation evidence for the `vpn` and `routing` Debian
# payloads. Run as root in a disposable container of the app image (it uses
# the image's own locks); every payload step runs as node, with no
# capabilities. Root is used only to fetch the PPP-family and stock strongSwan
# comparisons at the end, after the payload checks. Never touches a router.
#
#   docker run --rm -u root --entrypoint bash \
#     -v "$PWD/scripts:/probe:ro" -v "$PWD/test:/tests:ro" <image> \
#     /probe/research-vpn-routing.sh > docs/research/2026-11-06/vpn-routing-amd64.txt 2>&1
set -u
export LC_ALL=C
TOOLS=/data/.local/share/t3code-tools
node_sh() { runuser -u node -- env HOME=/data T3CODE_TOOL_GROUPS="vpn routing" bash -c "$1"; }
section() { printf '\n== %s\n' "$*"; }
run() { printf '$ %s\n' "$1"; node_sh "$1" 2>&1; printf '[exit %s]\n' "$?"; }

section "environment"
echo "date: $(date -u +%FT%TZ)  arch: $(dpkg --print-architecture)  $(. /etc/os-release && echo "$PRETTY_NAME")"
echo "t3: ${T3CODE_VER:-?}  kernel: $(uname -r)"
run 'id; grep CapEff /proc/self/status; echo "LD_LIBRARY_PATH=${LD_LIBRARY_PATH:-} LD_PRELOAD=${LD_PRELOAD:-}"'
for g in vpn routing; do
	jq -r '"\(.group): \(.packages|length) packages, \([.packages[].size]|add) B download, \([.packages[].installedSize]|add) B unpacked (apt Installed-Size)"' "/usr/local/lib/t3code/groups/$g/debs.lock.json"
	jq -r '"  " + ([.packages[]|"\(.name)=\(.version)"]|join(" "))' "/usr/local/lib/t3code/groups/$g/debs.lock.json"
done

section "install as node (the entrypoint runs this in the background)"
run 'time t3code-tools install'
run 't3code-tools status | grep -E "^(T3CODE|core|vpn|routing)"'
run "du -sb $TOOLS/groups/vpn/current/ $TOOLS/groups/routing/current/"
run "for g in vpn routing; do jq -c '{group, payloadId, durationMs, commands, libDirs: .deb.libDirs, skipped: .deb.skippedCommands, shadows: .deb.shadows, downloadedBytes: .deb.downloadedBytes}' $TOOLS/groups/\$g/current/manifest.json; done"
run "jq -r '.versions|to_entries[]|\"\\(.key): \\(.value)\"' $TOOLS/groups/vpn/current/manifest.json $TOOLS/groups/routing/current/manifest.json"
run "jq -c '.deb.wired|to_entries[]|{command: .key, env: .value.env, preload: [.value.preload[]|split(\"/\")|last]}' $TOOLS/groups/vpn/current/manifest.json"

section "strongSwan: what the wrapper fixes (raw binary, then each piece)"
R="$TOOLS/groups/vpn/current/root"
L="$R/usr/lib/ipsec:$R/usr/lib/ipsec/plugins:$R/usr/lib/x86_64-linux-gnu:$R/usr/lib/aarch64-linux-gnu"
run "cd /tmp; LD_LIBRARY_PATH=$L $R/usr/bin/pki --gen --type ed25519 --outform pem 2>&1 | tail -2"
run "cd /tmp; LD_LIBRARY_PATH=$L STRONGSWAN_CONF=$R/etc/strongswan.conf $R/usr/bin/pki --gen --type ed25519 --outform pem 2>&1 | tail -2"
run 'cd /tmp; pki --gen --type ed25519 --outform pem 2>/dev/null | head -1; pki --help 2>&1 | grep "loaded plugins"'
run 'cd /tmp; time (for i in $(seq 50); do pki --help >/dev/null 2>&1; done)'
run 'cd /tmp; time (for i in $(seq 50); do wg --version >/dev/null; done)'

section "nmap and BIRD find their files without variables"
run 'cd /tmp; nmap -d2 -sL -n 127.0.0.1 2>&1 | grep -m2 Fetchfile; echo "NMAPDIR=${NMAPDIR:-}"'
run "grep -ao '/etc/bird/bird.conf\\|/run/bird/bird.ctl' $TOOLS/groups/routing/current/root/usr/sbin/bird | sort -u"

section "functional scripts (the docker test runs the same ones)"
run 'bash /tests/vpn-tools.sh 2>/dev/null'
run 'bash /tests/routing-tools.sh'

section "PPP family (not shipped in vpn): compiled-in paths and root"
apt-get update -qq >/dev/null 2>&1
mkdir -p /tmp/ppp && chown node /tmp/ppp
(cd /tmp/ppp && apt-get download -q ppp xl2tpd sstp-client pppoe >/dev/null 2>&1) && chown -R node /tmp/ppp
run 'cd /tmp/ppp; ls *.deb; for f in *.deb; do dpkg-deb -x "$f" root; done'
run 'cd /tmp/ppp/root; LD_LIBRARY_PATH=$PWD/usr/lib/x86_64-linux-gnu:$PWD/usr/lib/aarch64-linux-gnu usr/sbin/pppd --version'
run 'cd /tmp/ppp/root; for b in usr/sbin/xl2tpd usr/sbin/sstpc; do echo "$b: $(grep -ao /usr/sbin/pppd "$b" | sort -u)"; done; echo "pppd: $(grep -ao "/etc/ppp/options" usr/sbin/pppd | sort -u)"'

section "stock Debian strongSwan prints the same plugin lines (root install, for comparison)"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends strongswan-pki >/dev/null 2>&1
printf '$ /usr/bin/pki --gen --type ed25519 (stock, as node)\n'
runuser -u node -- bash -c 'cd /tmp; /usr/bin/pki --gen --type ed25519 2>&1 >/dev/null | sed -n 1,3p; echo "[exit ${PIPESTATUS[0]}]"'
