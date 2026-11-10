#!/bin/bash
# Issue #5 slice 3 spike, run by docs/research/2026-11-tool-group-payloads/research-capture-bundle.ts as root in
# a disposable container (never on a router). Compares two ways to ship the
# `capture` group:
#   (a) the Debian closure the image lacks, downloaded, SHA256-checked and
#       extracted under /data as node (no root), with per-command wrappers
#       that set the payload's library dir for that process tree only;
#   (b) the same packages baked into the image with apt, gated by PATH only
#       (commands diverted out of /usr/bin into a group dir).
# Prints key=value measurements, then correctness transcripts, then the lock.
# Argument 1: the TZSP/DNS pcapng fixture, base64 (TZSP_DNS_PCAPNG).
set -eu; set -o pipefail
if ! command -v curl >/dev/null; then apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends curl ca-certificates iproute2 >/dev/null 2>&1; mkdir -p /data; chown node /data; fi
PKGS="${PKGS:-tcpdump tshark nfdump}"
FIXTURE_B64="$1"
out=/tmp/out; mkdir -p $out
now() { date +%s.%N; }
el() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.3f", b-a}'; }
triplet=$(dpkg-architecture -qDEB_HOST_MULTIARCH 2>/dev/null || gcc -dumpmachine 2>/dev/null || (case $(dpkg --print-architecture) in amd64) echo x86_64-linux-gnu;; arm64) echo aarch64-linux-gnu;; esac))
echo "arch=$(dpkg --print-architecture) triplet=$triplet" > $out/env
t0=$(now); apt-get update -qq >/dev/null 2>&1; t1=$(now)
echo "apt_update_s=$(el $t0 $t1)" >> $out/env
# Closure minus what the image already has, with SHA256 from the signed indexes.
apt-get install -s --no-install-recommends $PKGS | awk '/^Inst/{print $2"="substr($3,2)}' > $out/closure
# Key URIs by the decoded pool basename (pool names never carry an epoch; apt's local file names do).
apt-get install --print-uris -qq --no-install-recommends $PKGS | awk '{gsub(/'"'"'/,"",$1); n=split($1,a,"/"); k=a[n]; gsub(/%2[bB]/,"+",k); gsub(/%3[aA]/,":",k); gsub(/%7[eE]/,"~",k); print k" "$1}' | sort > $out/uris
apt-cache show --no-all-versions $(cat $out/closure) | awk -v RS= -F '\n' '{delete f; for(i=1;i<=NF;i++){j=index($i,": "); if(j) f[substr($i,1,j-1)]=substr($i,j+2)} print f["Package"]"\t"f["Version"]"\t"f["Size"]"\t"f["SHA256"]"\t"f["Filename"]}' > $out/show.tsv
: > $out/lock.tsv
while IFS=$(printf '\t') read -r name ver size sha fn; do
  uri=$(awk -v f="${fn##*/}" '$1==f{print $2}' $out/uris)
  [ -n "$uri" ] || { echo "no URI for $name=$ver ($fn)" >&2; exit 1; }
  printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$ver" "$size" "$sha" "${uri/http:/https:}" >> $out/lock.tsv
done < $out/show.tsv
echo "packages=$(wc -l < $out/lock.tsv) download_bytes=$(awk -F'\t' '{s+=$3}END{print s}' $out/lock.tsv)" >> $out/env
printf '%s' "$FIXTURE_B64" | base64 -d > /tmp/fixture.pcapng; chmod 644 /tmp/fixture.pcapng
chown -R node $out
# ---- (a) payload under the home, as node, no root ----
su node -s /bin/bash -c '
set -eu; out=/tmp/out; triplet='"$triplet"'
now() { date +%s.%N; }; el() { awk -v a="$1" -v b="$2" "BEGIN{printf \"%.3f\", b-a}"; }
P=/data/.local/share/t3code-tools/groups/capture/spike; mkdir -p $P/debs $P/root $P/bin
t0=$(now)
while IFS=$(printf "\t") read -r name ver size sha uri; do curl -fsSL --retry 3 -o "$P/debs/$name.deb" "$uri"; done < $out/lock.tsv
t1=$(now)
while IFS=$(printf "\t") read -r name ver size sha uri; do echo "$sha  $P/debs/$name.deb"; done < $out/lock.tsv | sha256sum -c --quiet
while IFS=$(printf "\t") read -r name ver size sha uri; do [ "$(dpkg-deb -f $P/debs/$name.deb Package)=$(dpkg-deb -f $P/debs/$name.deb Version)" = "$name=$ver" ]; done < $out/lock.tsv
t2=$(now)
for f in $P/debs/*.deb; do dpkg-deb -x "$f" $P/root; done
t3=$(now)
echo "a_download_s=$(el $t0 $t1) a_verify_s=$(el $t1 $t2) a_extract_s=$(el $t2 $t3)" >> $out/env
echo "a_installed_bytes=$(du -sb $P/root | cut -f1) a_debs_bytes=$(du -sb $P/debs | cut -f1)" >> $out/env
echo "a_tar_gz_bytes=$(tar -C $P -c root | gzip -6 | wc -c)" >> $out/env
rm -rf $P/debs
libdirs=$(cd $P/root && find . -name "lib*.so*" -printf "%h\n" | sort -u | sed "s|^\.|$P/root|" | paste -sd:)
echo "a_libdirs=$libdirs" >> $out/env
for b in $(ls $P/root/usr/bin $P/root/usr/sbin 2>/dev/null | grep -v :); do
  real=$P/root/usr/bin/$b; [ -e $real ] || real=$P/root/usr/sbin/$b
  printf "#!/bin/sh\np=\$(readlink -f -- \"\$0\"); p=\${p%%/bin/*}\nLD_LIBRARY_PATH=\"%s\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}\" exec \"\$p%s\" \"\$@\"\n" "$(echo $libdirs | sed "s|$P|\$p|g")" "${real#$P}" > $P/bin/$b
  chmod +x $P/bin/$b
done
# overlap: payload sonames that the image also has (would be shadowed)
: > $out/overlap; for f in $(cd $P/root && find . -name "lib*.so*" -printf "%f\n"); do for d in /usr/lib/$triplet /lib/$triplet; do [ -e $d/$f ] && echo $d/$f >> $out/overlap; done; done; true
echo "a_overlap=$(wc -l < $out/overlap)" >> $out/env
B=$P/bin; cd /tmp; F=/tmp/fixture.pcapng
{
echo "## tshark fields"; $B/tshark -r $F -T fields -e frame.number -e tzsp.encap -e dns.qry.name
echo "## tshark -G folders"; $B/tshark -G folders | grep -E "Program|Global (configuration|Plugins)"
echo "## plugins"; $B/tshark -G plugins | wc -l
echo "## tshark --version"; $B/tshark --version | head -1
echo "## capinfos"; $B/capinfos -c $F | tail -1
echo "## editcap -> pcap"; $B/editcap -F pcap $F /tmp/x.pcap && $B/capinfos -t /tmp/x.pcap | tail -1
echo "## mergecap"; $B/mergecap -w /tmp/m.pcapng $F $F && $B/capinfos -c /tmp/m.pcapng | tail -1
echo "## text2pcap"; $B/tshark -r $F -x | $B/text2pcap -q - /tmp/t.pcap && $B/tshark -r /tmp/t.pcap -T fields -e dns.qry.name
echo "## tcpdump -r"; $B/tcpdump -nr $F 2>&1 | head -2
# Interface listing and live capture record their exit codes rather than abort:
# under QEMU user-mode emulation the ethtool ioctl is not implemented.
echo "## capabilities of this shell (node)"; grep -E "^Cap(Eff|Prm)" /proc/self/status; echo "LD_LIBRARY_PATH=[${LD_LIBRARY_PATH:-}]"
echo "## dumpcap -D (no caps)"; $B/dumpcap -D 2>&1 && echo "exit=0" || echo "exit=$?"
echo "## tshark -D (no caps)"; $B/tshark -D 2>&1 | head -3; echo "exit=${PIPESTATUS[0]}"
echo "## dumpcap live lo (no caps)"; timeout 10 $B/dumpcap -i lo -c 1 -a duration:2 -w /tmp/live.pcapng 2>&1 | tail -2; echo "exit=${PIPESTATUS[0]}"
echo "## tcpdump live (no caps)"; timeout 10 $B/tcpdump -i lo -c 1 2>&1 | tail -1; echo "exit=${PIPESTATUS[0]}"
echo "## RADIUS fields with payload data dir / with it hidden"; $B/tshark -G fields | grep -c "^F.*radius\." || true; WIRESHARK_DATA_DIR=/nonexistent $B/tshark -G fields 2>/dev/null | grep -c "^F.*radius\." || true
echo "## nfcapd + nfdump (NetFlow v5 over UDP 9995, unprivileged)"
mkdir -p /tmp/nf; $B/nfcapd -w /tmp/nf -p 9995 -t 60 >/tmp/nfcapd.log 2>&1 & nf=$!; sleep 1
hdr="\x00\x05\x00\x01\x00\x00\x10\x00\x65\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00"
rec="\xc0\x00\x02\x01\xc0\x00\x02\x02\x00\x00\x00\x00\x00\x01\x00\x02\x00\x00\x00\x05\x00\x00\x01\xf4\x00\x00\x01\x00\x00\x00\x0f\x00\xa7\xf8\x00\x35\x00\x00\x11\x00\x00\x00\x00\x00\x18\x18\x00\x00"
printf "$hdr$rec" > /dev/udp/127.0.0.1/9995; sleep 1; kill -TERM $nf; wait $nf || true
$B/nfdump -R /tmp/nf -q -o "fmt:%sa %da %dp %pkt %byt" 2>&1 | head -3
echo "## nfdump -V"; $B/nfdump -V
echo "## ld.so --library-path variant (no env leak)"; /lib/$triplet/ld-linux-*.so.* --library-path "$libdirs" $P/root/usr/bin/tshark -G folders 2>&1 | grep -E "Program|Global Plugins"
} > $out/a-correctness.txt 2>&1
# timing: wrapper decode, cold-ish first and warm average
t0=$(now); $B/tshark -r $F -T fields -e dns.qry.name >/dev/null; t1=$(now)
for i in 1 2 3 4 5; do $B/tshark -r $F -T fields -e dns.qry.name >/dev/null; done; t2=$(now)
echo "a_tshark_first_s=$(el $t0 $t1) a_tshark_warm_avg_s=$(awk -v a=$t1 -v b=$t2 "BEGIN{printf \"%.3f\",(b-a)/5}")" >> $out/env
t0=$(now); for i in 1 2 3 4 5; do $B/tcpdump --version >/dev/null 2>&1; done; t1=$(now)
t2=$(now); for i in 1 2 3 4 5; do LD_LIBRARY_PATH=$libdirs $P/root/usr/bin/tcpdump --version >/dev/null 2>&1; done; t3=$(now)
echo "a_wrapper_overhead_ms=$(awk -v a=$t0 -v b=$t1 -v c=$t2 -v d=$t3 "BEGIN{printf \"%.1f\",((b-a)-(d-c))/5*1000}")" >> $out/env
'
# ---- (b) baked into the image, gated by PATH ----
before=$(mktemp); after=$(mktemp)
dpkg-query -W -f='${Package}\n' | sort > $before
t0=$(now); DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $PKGS >/dev/null 2>&1; t1=$(now)
dpkg-query -W -f='${Package}\n' | sort > $after
new=$(comm -13 $before $after)
files=$(for p in $new; do dpkg -L $p; done | sort -u | while read -r f; do if [ -f "$f" ] && [ ! -L "$f" ]; then echo "$f"; fi; done)
echo "b_install_s=$(el $t0 $t1) b_new_packages=$(echo $new | wc -w)" >> $out/env
echo "b_files_bytes=$(echo "$files" | xargs -d '\n' stat -c %s | awk '{s+=$1}END{print s}' )" >> $out/env
echo "b_layer_gz_bytes=$(echo "$files" | tar -c -T - 2>/dev/null | gzip -6 | wc -c)" >> $out/env
# PATH gating: divert the commands out of /usr/bin into a group dir
gd=/usr/lib/t3code/capture/usr/bin; mkdir -p $gd; ln -s /usr/share /usr/lib/t3code/capture/usr/share; ln -s /usr/lib /usr/lib/t3code/capture/usr/lib
for b in tshark dumpcap capinfos editcap mergecap text2pcap tcpdump nfdump nfcapd; do
  p=/usr/bin/$b; [ -e $p ] || p=/usr/sbin/$b
  dpkg-divert --quiet --local --rename --divert $gd/$b --add $p
done
{ echo "## command -v tshark after divert: $(command -v tshark || echo none)"
  su node -s /bin/sh -c "$gd/tshark -G folders | grep -E 'Program|Global (configuration|Plugins)'; $gd/tshark -G plugins | wc -l; $gd/tshark -r /tmp/fixture.pcapng -T fields -e dns.qry.name; $gd/tshark -D 2>&1 | head -2"
} > $out/b-correctness.txt 2>&1
F=/tmp/fixture.pcapng
t0=$(now); su node -s /bin/sh -c "$gd/tshark -r $F -T fields -e dns.qry.name >/dev/null"; t1=$(now)
echo "b_tshark_first_s=$(el $t0 $t1)" >> $out/env
cat $out/env; echo; cat $out/a-correctness.txt; echo; cat $out/b-correctness.txt; echo; echo "## lock"; cat $out/lock.tsv; echo "## overlap"; cat $out/overlap
