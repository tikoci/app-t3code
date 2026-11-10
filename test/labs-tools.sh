#!/bin/bash
# Functional check of the `labs` payload inside the container, run by
# test/container-replacement.test.ts as node with no capabilities: QEMU from
# the payload loads its BIOS, option ROM and UEFI images through the
# wrapper's -L dirs (the image has none of them), the arm emulator runs code,
# qemu-img writes qcow2, the unused firmware is pruned, and KVM and TAP are
# unavailable rather than granted. Booting a CHR with quickchr is the
# research probe's job (docs/research/2026-11-tool-group-payloads/research-quickchr-runtime.ts).
set -euo pipefail
rm -rf /tmp/labs-check && mkdir /tmp/labs-check && cd /tmp/labs-check

home=${T3CODE_TOOLS_HOME:-/data/.local/share/t3code-tools}
tools=$home/bin
root=$(readlink -f "$home/groups/labs/current")/root
for c in qemu-system-x86_64 qemu-system-aarch64 qemu-system-i386 qemu-system-arm kvm qemu-img; do test "$(command -v "$c")" = "$tools/$c"; done
test "$(command -v quickchr)" = /opt/bun/bin/quickchr
# Nothing of QEMU in the image: every file below comes from the payload.
for path in /usr/bin/qemu-system-x86_64 /usr/bin/qemu-img /usr/share/qemu /usr/share/seabios /usr/share/AAVMF; do test ! -e "$path"; done
test -z "${LD_LIBRARY_PATH:-}"

# The wrapper's -L dirs come first in QEMU's own search list.
mapfile -t dirs < <(qemu-system-x86_64 -L help)
test "${dirs[0]}" = "$root/usr/share/qemu"
test "${dirs[1]}" = "$root/usr/share/seabios"
test "${dirs[2]}" = "$root/usr/lib/ipxe/qemu"
# Debian's kvm is a link to qemu-system-x86_64 and gets the same wrapper rule.
test "$(kvm -L help | head -1)" = "$root/usr/share/qemu"

# Pruned: the secure-boot AAVMF images. Kept: the pair quickchr boots.
# (Separate statements: under set -e, a failed test left of && does not stop the script.)
test ! -e "$root/usr/share/AAVMF/AAVMF_CODE.secboot.fd"
test ! -e "$root/usr/share/AAVMF/AAVMF_VARS.ms.fd"
test "$(readlink "$root/usr/share/AAVMF/AAVMF_CODE.fd")" = AAVMF_CODE.no-secboot.fd
test "$(stat -c %s "$root/usr/share/AAVMF/AAVMF_VARS.fd")" = 67108864

# quickchr must discover the relocated firmware too. Presence and QEMU's
# own boots can pass even with a quickchr build that still fails arm64 CHRs.
quickchr doctor --json >doctor.json
jq -e --arg code "$root/usr/share/AAVMF/AAVMF_CODE.fd" \
	'.checks | any(.label == "UEFI firmware" and .status == "ok" and .detail == $code)' doctor.json >/dev/null

# The BIOS and the virtio NIC's option ROM resolve through the -L dirs. QEMU
# refuses to start when it cannot find a romfile, which the nonexistent one
# shows; the default efi-virtio.rom must start cleanly.
nic() { qemu-system-x86_64 -M pc -accel tcg -S -display none -nodefaults -netdev user,id=n -device "virtio-net-pci,netdev=n$1" -monitor stdio <<<$'info roms\nquit' 2>&1; }
roms=$(nic "")
grep -q 'name="bios-256k.bin"' <<<"$roms"
set +e
missing=$(nic ",romfile=t3code-nonexistent.rom")
missing_rc=$?
set -e
if [ "$missing_rc" -eq 0 ]; then echo "a missing romfile did not stop QEMU: $missing" >&2; exit 1; fi
grep -q 'failed to find romfile' <<<"$missing"

# qemu-img (no wrapper rule) creates and reads a qcow2.
qemu-img create -f qcow2 disk.qcow2 16M >/dev/null
grep -q '"format": "qcow2"' <<<"$(qemu-img info --output=json disk.qcow2)"

# LABS_TOOLS_QEMU_USER=1 skips the boots: TCG inside QEMU user-mode emulation
# (arm64 image on an amd64 host) is too slow for a test budget.
if [ -z "${LABS_TOOLS_QEMU_USER:-}" ]; then
	# SeaBIOS boots, finds nothing and exits (reboot-timeout=0 with -no-reboot).
	bios=$(timeout 60 qemu-system-x86_64 -M pc -accel tcg -display none -nodefaults -no-reboot -boot reboot-timeout=0 \
		-chardev stdio,id=d -device isa-debugcon,iobase=0x402,chardev=d 2>&1)
	grep -q 'SeaBIOS (version' <<<"$bios"
	grep -q 'No bootable device' <<<"$bios"
	# A 16-byte aarch64 program (AARCH64_PSCI_OFF) powers the virt machine off.
	printf '\x00\x01\x80\x52\x00\x80\xb0\x72\x02\x00\x00\xd4\x00\x00\x00\x14' >psci-off.bin
	timeout 30 qemu-system-aarch64 -M virt -cpu cortex-a710 -accel tcg -display none -nodefaults -no-reboot -kernel psci-off.bin
	# UEFI (AAVMF) from the payload starts and prints its banner on the serial port.
	cp "$root/usr/share/AAVMF/AAVMF_VARS.fd" vars.fd
	set +e
	uefi=$(timeout 20 qemu-system-aarch64 -M virt -cpu cortex-a710 -accel tcg -display none -nodefaults -serial stdio \
		-drive "if=pflash,format=raw,readonly=on,unit=0,file=$root/usr/share/AAVMF/AAVMF_CODE.fd" -drive if=pflash,format=raw,unit=1,file=vars.fd 2>&1)
	rc=$?
	set -e
	# 124: still running at the timeout, as firmware with no boot device keeps going.
	if [ "$rc" -ne 124 ] && [ "$rc" -ne 0 ]; then echo "UEFI boot exited $rc: $uefi" >&2; exit 1; fi
	grep -aq 'UEFI firmware' <<<"$uefi" || { echo "no UEFI banner: ${uefi:0:400}" >&2; exit 1; }
fi

# Acceleration and TAP need what the container does not give node: they
# must fail, not silently succeed.
set +e
kvm=$(timeout 10 qemu-system-x86_64 -M pc -accel kvm -display none -nodefaults -S -monitor none 2>&1)
kvm_rc=$?
tap=$(timeout 10 qemu-system-x86_64 -M pc -accel tcg -display none -nodefaults -S -monitor none -netdev tap,id=t,ifname=t3labs0,script=no,downscript=no 2>&1)
tap_rc=$?
set -e
if [ ! -w /dev/kvm ]; then
	if [ "$kvm_rc" -eq 0 ]; then echo "KVM acceleration started without /dev/kvm" >&2; exit 1; fi
	grep -qi 'kvm' <<<"$kvm"
fi
if [ "$tap_rc" -eq 0 ]; then echo "a TAP device opened without CAP_NET_ADMIN" >&2; exit 1; fi
grep -Eqi 'tun|permission|not permitted' <<<"$tap"

echo "labs ok: $(qemu-system-x86_64 --version | head -1); $(qemu-img --version | head -1)"
