#!/bin/bash
# Functional check of the `vpn` payload inside the container, run by
# test/container-replacement.test.ts as node with no capabilities: WireGuard
# keys, a strongSwan CA and host certificate (the RouterOS IKEv2 workflow)
# with the payload's own config and plugins, an OpenVPN static key, and an
# unprivileged IKE probe. No tunnel is started: that needs CAP_NET_ADMIN (#7).
set -euo pipefail
cd /tmp
rm -rf /tmp/vpn-check && mkdir /tmp/vpn-check && cd /tmp/vpn-check

# Tools come from the payload shims, not the image, with no global library path.
tools=${T3CODE_TOOLS_HOME:-/data/.local/share/t3code-tools}/bin
for c in wg pki swanctl openvpn ike-scan; do test "$(command -v "$c")" = "$tools/$c"; done
test ! -e /usr/bin/wg && test ! -e /usr/bin/pki
test -z "${LD_LIBRARY_PATH:-}" && test -z "${LD_PRELOAD:-}" && test -z "${STRONGSWAN_CONF:-}"

# WireGuard: a key pair (what /interface/wireguard/peers needs from a Linux peer).
wg genkey >wg.key
wg pubkey <wg.key >wg.pub
grep -Eqx '[A-Za-z0-9+/]{43}=' wg.pub

# strongSwan reads the payload's strongswan.conf and loads the payload's
# plugins: a CA, a host key, a certificate with a SAN, and verification.
pki --help 2>&1 | grep -q 'loaded plugins: .*openssl'
pki --gen --type ed25519 --outform pem >ca.key
pki --self --ca --in ca.key --type priv --dn 'CN=lab-ca' --outform pem >ca.pem
pki --gen --type rsa --size 2048 --outform pem >host.key
pki --req --in host.key --type priv --dn 'CN=router.lab' --san router.lab --outform pem >host.csr
pki --issue --cacert ca.pem --cakey ca.key --type pkcs10 --in host.csr --flag serverAuth --outform pem >host.pem
pki --verify --in host.pem --cacert ca.pem | grep -q 'certificate trusted'
pki --print --in host.pem | grep -q 'altNames:  router.lab'
swanctl --help 2>&1 | grep -q '^strongSwan [0-9.]* swanctl'
# No charon: swanctl reaches for its socket and reports that, nothing else.
if swanctl --stats >out.txt 2>&1; then echo "swanctl found a charon" >&2; exit 1; fi
grep -q "connecting to 'unix:///var/run/charon.vici' failed" out.txt

# OpenVPN: a static key; ike-scan: an unprivileged source port, no responder.
openvpn --genkey secret ovpn.key
grep -q 'BEGIN OpenVPN Static key' ovpn.key
timeout 20 ike-scan --sport=0 --retry=1 127.0.0.1 2>&1 | grep -q '1 hosts scanned'

echo "vpn ok: $(wg --version | cut -d' ' -f1-2); $(pki --help 2>/dev/null | head -1); $(openvpn --version | head -1 | cut -d' ' -f1-2)"
