// Render a complete comparison of GitHub's published apt tables with a saved
// image inventory. Uses explicit mappings instead of treating Ubuntu/Debian
// package renames as missing capabilities. Does not compare version equality.
const directory = process.argv[2] ?? "docs/research/2026-11-agent-tools";
const source = await Bun.file(`${directory}/runner-packages.json`).json();
const image = await Bun.file(`${directory}/image-amd64/inventory.json`).json();
const installed = new Map<string, string>(image.packages.map((p: { name: string; version: string }) => [p.name.replace(/:.*$/, ""), p.version]));
const aliases: Record<string, string> = { dnsutils: "bind9-dnsutils", gnupg2: "gnupg", netcat: "netcat-openbsd",
	"p7zip-full": "7zip", "p7zip-rar": "7zip-rar", ssh: "openssh-client" };
const names = [...new Set<string>(source.runners.flatMap((r: { aptPackages: { name: string }[] }) => r.aptPackages.map((p) => p.name)))].sort();
const header = ["runner_package", "debian_package", "image_amd64", "ubuntu_24.04_x64", "ubuntu_24.04_arm64", "ubuntu_26.04_x64", "ubuntu_26.04_arm64"];
const rows = names.map((name) => {
	const debian = aliases[name] ?? name;
	return [name, debian, installed.get(debian) ?? "MISSING", ...source.runners.map((r: { aptPackages: { name: string; version: string }[] }) => r.aptPackages.find((p) => p.name === name)?.version ?? "NOT LISTED")];
});
await Bun.write(`${directory}/apt-comparison.tsv`, `${[header, ...rows].map((r) => r.join("\t")).join("\n")}\n`);
await Bun.write(`${directory}/apt-comparison.md`, "# Published runner apt packages compared with our image\n\n" +
	"Every row from all four published apt tables is included. NOT LISTED means absent from that table, not proven absent from the runner.\n\n" +
	"Debian aliases are explicit. Mapping `ssh` to `openssh-client` compares only the client; we do not ship an SSH server. Presence of libraries does not imply their CLI tools (e.g. libsqlite3 vs sqlite3).\n\n" +
	[header, header.map(() => "---"), ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n") + "\n");
