#!/bin/bash
# Issue #5 slice 5: can Debian's QEMU run from a payload under /data as node?
# Run on a host with Docker, from the repo root:
#
#   docs/research/2026-11-tool-group-payloads/research-labs-payload.sh [base-image] > docs/research/2026-11-tool-group-payloads/labs-qemu-amd64.txt
#
# The base image (default app-t3code:pr10-review, an image that still has
# QEMU) runs as root only to purge QEMU and download the closure with apt; the
# packages are extracted and every probe runs as node with no capabilities. No
# wrapper from this repo is used: the probes call the binaries directly, with
# and without -L, to show what the labs wrapper rule has to provide.
set -euo pipefail
base=${1:-app-t3code:pr10-review}
inner=$(mktemp)
trap 'rm -f "$inner"' EXIT
cat >"$inner" <<'OUTER'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive LC_ALL=C
roots="qemu-system-x86 qemu-system-arm qemu-efi-aarch64 qemu-utils"
apt-get purge -y $roots >/dev/null 2>&1
apt-get autoremove --purge -y >/dev/null 2>&1
apt-get update -qq
mkdir -p /tmp/debs && cd /tmp/debs
apt-get install -s --no-install-recommends $roots | awk '/^Inst/{print $2}' >list
echo "== closure of $roots that the image lacks: $(wc -l <list) packages"
xargs apt-cache show --no-all-versions <list | awk '/^Size:/{s+=$2} /^Installed-Size:/{i+=$2} END{printf "download %.1f MiB, installed %.1f MiB (apt metadata)\n", s/1048576, i/1024}'
chown -R _apt /tmp/debs
apt-get download $(cat list) >/dev/null 2>&1
mkdir -p /tmp/p/root && chown -R node:node /tmp/p
su node -s /bin/bash -c 'for d in /tmp/debs/*.deb; do dpkg-deb -x "$d" /tmp/p/root; done'
printf '\x00\x01\x80\x52\x00\x80\xb0\x72\x02\x00\x00\xd4\x00\x00\x00\x14' >/tmp/psci-off.bin
chmod 644 /tmp/psci-off.bin
cat >/tmp/probe.sh <<'INNER'
R=/tmp/p/root
T=$(dpkg-architecture -qDEB_HOST_MULTIARCH 2>/dev/null || gcc -dumpmachine 2>/dev/null || echo x86_64-linux-gnu)
L=$R/usr/lib/$T:$R/usr/lib/$T/rsocket:$R/usr/lib/$T/vdeplug
DL="-L $R/usr/share/qemu -L $R/usr/share/seabios -L $R/usr/lib/ipxe/qemu"
q() { LD_LIBRARY_PATH=$L "$@"; }
ms() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }
echo "== who: $(id -un), $(grep CapEff /proc/self/status | tr -s '\t' ' '), /dev/kvm: $(test -e /dev/kvm && echo present || echo absent)"
echo "== image paths after the purge"; ls -d /usr/share/qemu /usr/share/seabios /usr/share/AAVMF /usr/lib/ipxe/qemu 2>&1
echo "== payload: $(du -sm $R | cut -f1) MiB unpacked; AAVMF $(du -sm $R/usr/share/AAVMF | cut -f1) MiB"
ls -la $R/usr/share/AAVMF | awk 'NR>3{print $1, $5, $9, $10, $11}'
echo "== absolute or dangling symlinks in the payload"
find $R -type l \( -lname '/*' -o -xtype l \) -printf '%P -> %l\n' | head; echo "(end)"
echo "== library dirs"; find $R -name 'lib*.so*' -printf '%h\n' | sort -u | sed "s|$R/||"
echo "== binaries"; ls $R/usr/bin | tr '\n' ' '; echo
echo "== compiled-in data dirs"; grep -aoE '/usr/(share|lib)/(qemu|seabios|ipxe)[a-z/]*' $R/usr/bin/qemu-system-x86_64 | sort -u
echo "== -L help, raw binary"; q $R/usr/bin/qemu-system-x86_64 -L help
echo "== -L help, with three leading -L"; q $R/usr/bin/qemu-system-aarch64 $DL -L help
echo "== --version after leading -L"; q $R/usr/bin/qemu-system-x86_64 $DL --version | head -1
B="-M pc -accel tcg -display none -nodefaults -no-reboot -boot reboot-timeout=0 -chardev stdio,id=d -device isa-debugcon,iobase=0x402,chardev=d"
echo "== x86 SeaBIOS boot without -L"; q timeout 20 $R/usr/bin/qemu-system-x86_64 $B 2>&1 | head -2; echo "exit ${PIPESTATUS[0]}"
echo "== x86 SeaBIOS boot with -L (the labs smoke test)"
s=$(date +%s%N); out=$(q timeout 60 $R/usr/bin/qemu-system-x86_64 $DL $B 2>&1); rc=$?
grep -aE 'SeaBIOS \(version|No bootable device' <<<"$out"; echo "exit $rc in $(ms $s) ms"
echo "== x86 with a virtio NIC (iPXE runs: why the smoke test has no NIC)"
s=$(date +%s%N); q timeout 60 $R/usr/bin/qemu-system-x86_64 $DL $B -netdev user,id=n -device virtio-net-pci,netdev=n >/dev/null 2>&1; echo "exit $? in $(ms $s) ms"
echo "== a missing romfile stops QEMU; the default one loads"
q $R/usr/bin/qemu-system-x86_64 $DL -M pc -accel tcg -S -display none -nodefaults -netdev user,id=n -device virtio-net-pci,netdev=n,romfile=t3code-nonexistent.rom -monitor none 2>&1 | head -1
q timeout 5 $R/usr/bin/qemu-system-x86_64 $DL -M pc -accel tcg -S -display none -nodefaults -netdev user,id=n -device virtio-net-pci,netdev=n -monitor stdio <<<quit >/dev/null 2>&1; echo "default efi-virtio.rom: exit $?"
echo "== aarch64 PSCI SYSTEM_OFF kernel (the labs smoke test)"
s=$(date +%s%N); q timeout 30 $R/usr/bin/qemu-system-aarch64 $DL -M virt -cpu cortex-a710 -accel tcg -display none -nodefaults -no-reboot -kernel /tmp/psci-off.bin; echo "exit $? in $(ms $s) ms"
echo "== aarch64 control: 16 zero bytes hang until the timeout"
head -c 16 /dev/zero >/tmp/zero.bin
q timeout 5 $R/usr/bin/qemu-system-aarch64 $DL -M virt -cpu cortex-a710 -accel tcg -display none -nodefaults -no-reboot -kernel /tmp/zero.bin 2>/dev/null; echo "exit $? (124 = timeout)"
echo "== aarch64 UEFI from the payload's AAVMF pair (20 s)"
cp $R/usr/share/AAVMF/AAVMF_VARS.fd /tmp/vars.fd
q timeout 20 $R/usr/bin/qemu-system-aarch64 $DL -M virt -cpu cortex-a710 -accel tcg -display none -nodefaults -serial stdio \
	-drive if=pflash,format=raw,readonly=on,unit=0,file=$R/usr/share/AAVMF/AAVMF_CODE.fd -drive if=pflash,format=raw,unit=1,file=/tmp/vars.fd 2>&1 | grep -a -m1 'UEFI firmware'
echo "== QEMU modules: what QEMU_MODULE_DIR adds"
ls $R/usr/lib/$T/qemu | tr '\n' ' '; echo
echo "accel without: $(q $R/usr/bin/qemu-system-x86_64 -accel help | tail -n +2 | tr '\n' ' ')"
echo "display without: $(q $R/usr/bin/qemu-system-x86_64 -display help | sed -n 2,4p | tr '\n' ' ')"
echo "display with: $(QEMU_MODULE_DIR=$R/usr/lib/$T/qemu q $R/usr/bin/qemu-system-x86_64 -display help | sed -n 2,4p | tr '\n' ' ')"
echo "== qemu-img"; q $R/usr/bin/qemu-img create -f qcow2 /tmp/d.qcow2 16M; echo "exit $?"
echo "== KVM and TAP as node"
q timeout 10 $R/usr/bin/qemu-system-x86_64 $DL -M pc -accel kvm -display none -nodefaults -S -monitor none 2>&1 | head -1
q timeout 10 $R/usr/bin/qemu-system-x86_64 $DL -M pc -accel tcg -display none -nodefaults -S -monitor none -netdev tap,id=t,ifname=t3labs0,script=no,downscript=no 2>&1 | head -1
echo "== kvm (Debian's alias for qemu-system-x86_64 -enable-kvm)"; ls -l $R/usr/bin/kvm | awk '{print $1, $5, $9, $10, $11}'; q $R/usr/bin/kvm $DL --version 2>&1 | head -1
INNER
su node -s /bin/bash /tmp/probe.sh
OUTER
echo "# $(date -u +%FT%TZ) base=$base host=$(uname -m) docker=$(docker version -f '{{.Server.Version}}')"
docker run --rm --user root -v "$inner":/research.sh:ro --entrypoint bash "$base" /research.sh
