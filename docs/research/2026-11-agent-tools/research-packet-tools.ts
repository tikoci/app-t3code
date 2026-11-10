// Disposable Debian image only: installs packet tools, then proves the normal
// node user can decode a synthetic RouterOS-style TZSP packet in a pcapng file.
// Sends no packets and does not contact a router or enable capture privileges.
function run(args: string[]) {
	const p = Bun.spawnSync(args, { env: { ...process.env, LC_ALL: "C", DEBIAN_FRONTEND: "noninteractive" } });
	if (p.exitCode !== 0) throw new Error(`${args.join(" ")}: ${p.stderr.toString()} ${p.stdout.toString()}`);
	return p.stdout.toString().trim();
}

run(["apt-get", "update"]);
const aptInstallOutput = run(["apt-get", "install", "-y", "--no-install-recommends", "tcpdump", "tshark"]);

function ethernetIPv4UDP(payload: Buffer, sourcePort: number, destinationPort: number) {
	const packet = Buffer.alloc(14 + 20 + 8 + payload.length);
	Buffer.from("0200000000020200000000010800", "hex").copy(packet);
	const ip = packet.subarray(14, 34);
	ip[0] = 0x45;
	ip.writeUInt16BE(20 + 8 + payload.length, 2);
	ip[8] = 64;
	ip[9] = 17;
	Buffer.from([192, 0, 2, 1, 192, 0, 2, 2]).copy(ip, 12);
	let checksum = 0;
	for (let offset = 0; offset < 20; offset += 2) checksum += ip.readUInt16BE(offset);
	while (checksum >>> 16) checksum = (checksum & 0xffff) + (checksum >>> 16);
	ip.writeUInt16BE((~checksum) & 0xffff, 10);
	packet.writeUInt16BE(sourcePort, 34);
	packet.writeUInt16BE(destinationPort, 36);
	packet.writeUInt16BE(8 + payload.length, 38);
	payload.copy(packet, 42);
	return packet;
}
const dns = Buffer.from("12340100000100000000000008726f757465726f73076578616d706c650000010001", "hex");
const inner = ethernetIPv4UDP(dns, 12345, 53);
const tzsp = Buffer.concat([Buffer.from([1, 0, 0, 1, 1]), inner]);
const packet = ethernetIPv4UDP(tzsp, 43000, 37008);
const section = Buffer.alloc(28);
section.writeUInt32LE(0x0a0d0d0a);
section.writeUInt32LE(28, 4);
section.writeUInt32LE(0x1a2b3c4d, 8);
section.writeUInt16LE(1, 12);
section.writeBigInt64LE(-1n, 16);
section.writeUInt32LE(28, 24);
const iface = Buffer.alloc(20);
iface.writeUInt32LE(1);
iface.writeUInt32LE(20, 4);
iface.writeUInt16LE(1, 8);
iface.writeUInt32LE(65535, 12);
iface.writeUInt32LE(20, 16);
const blockLength = 32 + Math.ceil(packet.length / 4) * 4;
const block = Buffer.alloc(blockLength);
block.writeUInt32LE(6);
block.writeUInt32LE(blockLength, 4);
block.writeUInt32LE(1_000_000, 16);
block.writeUInt32LE(packet.length, 20);
block.writeUInt32LE(packet.length, 24);
packet.copy(block, 28);
block.writeUInt32LE(blockLength, blockLength - 4);
const capture = Buffer.concat([section, iface, block]);
await Bun.write("/tmp/routeros-tzsp-example.pcapng", capture);

const asNode = (args: string[]) => run(["runuser", "-u", "node", "--", ...args]);
const fields = asNode(["tshark", "-n", "-r", "/tmp/routeros-tzsp-example.pcapng", "-Y", "tzsp && dns",
	"-T", "fields", "-e", "tzsp.encap", "-e", "dns.qry.name"]);
if (fields !== "1\trouteros.example") throw new Error(`TZSP decode failed: ${fields}`);
const json = JSON.parse(asNode(["tshark", "-n", "-r", "/tmp/routeros-tzsp-example.pcapng", "-Y", "tzsp && dns",
	"-T", "json", "-e", "dns.qry.name"]));
if (json[0]?._source.layers["dns.qry.name"]?.[0] !== "routeros.example") throw new Error("JSON decode failed");
const wanted = new Set(["tzsp", "dns", "dhcp", "dhcpv6", "radius", "snmp", "isakmp", "esp", "ah", "wg", "bgp", "ospf", "lldp", "mndp", "vxlan"]);
const protocols = asNode(["tshark", "-G", "protocols"]).split("\n").filter((line) => wanted.has(line.split("\t")[2] ?? ""));
console.log(JSON.stringify({ generatedAt: new Date().toISOString(),
	method: "Only a disposable baseline container was modified. Synthetic Ethernet/IPv4/UDP/TZSP/Ethernet/IPv4/UDP/DNS packet inside pcapng, decoded as node with no added capabilities. No live capture, router access, IKE negotiation, or RouterOS-hosted runtime was tested.",
	aptInstallOutput, packageVersions: run(["dpkg-query", "-W", "tcpdump", "tshark", "wireshark-common"]),
	captureBase64: capture.toString("base64"), fields, json, protocols,
	capinfos: asNode(["capinfos", "/tmp/routeros-tzsp-example.pcapng"]),
	wiresharkCommonExecutables: run(["dpkg-query", "-L", "wireshark-common"]).split("\n").filter((p) => /^\/usr\/bin\//.test(p)),
}, null, 2));
