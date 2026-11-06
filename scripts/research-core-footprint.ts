// Run inside the unchanged image. Measures directory allocation and simulates
// dependency-aware removal candidates without updating apt or deleting files.
function run(args: string[]) {
	const p = Bun.spawnSync(args, { env: { ...process.env, LC_ALL: "C" } });
	if (p.exitCode !== 0) throw new Error(`${args[0]}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}
const labs = ["qemu-system-x86", "qemu-system-arm", "qemu-efi-aarch64", "qemu-utils"];
const browser = ["fontconfig", "fonts-liberation", "libasound2t64", "libatk-bridge2.0-0t64", "libatk1.0-0t64",
	"libatspi2.0-0t64", "libdbus-1-3", "libexpat1", "libgbm1", "libglib2.0-0t64", "libnss3", "libx11-6",
	"libxcb1", "libxcomposite1", "libxdamage1", "libxext6", "libxfixes3", "libxkbcommon0", "libxrandr2"];
// biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query field syntax.
const sizes = new Map(run(["dpkg-query", "-W", "-f=${binary:Package}\t${Installed-Size}\n"]).split("\n")
	.map((line): [string, number] => { const [name, size] = line.split("\t"); return [(name as string).replace(/:.*$/, ""), Number(size)]; }));
const originalState = await Bun.file("/var/lib/apt/extended_states").text();
const scenarios = [];
for (const [label, packages] of Object.entries({ unchanged: [], labs, browser, "labs-and-browser": [...labs, ...browser] })) {
	const state = `/tmp/core-footprint-${label}.extended_states`;
	await Bun.write(state, originalState);
	const option = `Dir::State::extended_states=${state}`;
	if (packages.length) run(["apt-mark", "-o", option, "auto", ...packages]);
	const simulation = run(["apt-get", "-o", option, "--simulate", "autoremove"]);
	const removed = [...simulation.matchAll(/^Remv (\S+)/gm)].map((m) => ({ name: m[1] as string,
		installedSizeKiB: sizes.get((m[1] as string).replace(/:.*$/, "")) ?? 0 }));
	scenarios.push({ label, packages, removed, removedInstalledKiB: removed.reduce((sum, p) => sum + p.installedSizeKiB, 0), simulation });
}
const paths = ["/opt/t3code", "/opt/bun", "/usr/local/lib/node_modules/@openai/codex",
	"/usr/local/lib/node_modules/opencode-ai", "/usr/local/bin/muse", "/usr/local/bin/node", "/usr/local/bin/bun"];
const directories = paths.map((path) => ({ path, allocatedBytes: Number(run(["du", "-s", "-B1", path]).split(/\s/)[0]) }));
const opencodePaths = ["opencode-linux-x64", "opencode-linux-x64-baseline"].map((name) =>
	`/usr/local/lib/node_modules/opencode-ai/node_modules/${name}/bin/opencode`);
const duplicateCandidates = opencodePaths.map((path) => ({ path,
	sha256: run(["sha256sum", path]).split(/\s/)[0],
	fileBytes: Bun.file(path).size,
	inodeAndLinks: run(["stat", "-c", "%i %h", path]),
}));
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), architecture: process.arch,
	method: "Existing amd64 image, no apt indexes refreshed or installed-package state changed. For each scenario copy the apt auto/manual state into /tmp, mark only that group's explicit packages auto in the copy, and simulate autoremove using the copy. This retains packages required by other manual roots, e.g. Python's libexpat. Installed-Size metadata differs from du allocation; neither is a compressed OCI delta. Native application dependencies outside dpkg are not modeled. Browser removal can therefore still break native tools and requires runtime tests.",
	directories, scenarios, duplicateCandidates }, null, 2));
