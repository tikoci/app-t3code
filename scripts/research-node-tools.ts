// Run in a disposable baseline-image container as root. Installs candidates
// into temporary prefixes, measures each and the combined toolset, then removes
// them. The production image and home volume are not changed.
import { rm } from "node:fs/promises";

const names = ["typescript", "cspell", "markdownlint-cli2", "@biomejs/biome"];
const prefix = "/tmp/app-t3code-node-tools";
function run(args: string[], env: Record<string, string | undefined> = {}) {
	const p = Bun.spawnSync(args, { env: { ...process.env, ...env, LC_ALL: "C", NO_COLOR: "1" } });
	if (p.exitCode !== 0) throw new Error(`${args[0]} failed: ${p.stderr.toString()} ${p.stdout.toString()}`);
	return p.stdout.toString().trim();
}

const registry = [];
for (const name of names) {
	const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
	if (!response.ok) throw new Error(`npm metadata ${name}: ${response.status}`);
	const p = await response.json() as { name: string; version: string; engines?: unknown; license?: string;
		bin?: unknown; dependencies?: unknown; optionalDependencies?: unknown; dist: unknown; repository?: unknown };
	registry.push({ name: p.name, version: p.version, engines: p.engines, license: p.license,
		bin: p.bin, dependencies: p.dependencies, optionalDependencies: p.optionalDependencies,
		dist: p.dist, repository: p.repository, source: response.url });
}
const specifications = registry.map((p) => `${p.name}@${p.version}`);
const scenarios = [...registry.map((p) => ({ label: p.name, specs: [`${p.name}@${p.version}`] })),
	{ label: "combined-node-tools", specs: specifications }];
const measurements = [];
await Bun.write("/tmp/app-t3code-markdown-probe.md", "# Probe\n\nA paragraph.\n");
for (const scenario of scenarios) {
	await rm(prefix, { recursive: true, force: true });
	const install = run(["npm", "install", "--prefix", prefix, "--cache", "/tmp/app-t3code-npm-cache",
		"--ignore-scripts", "--no-audit", "--no-fund", "--fetch-timeout=20000", "--fetch-retries=1", ...scenario.specs]);
	const diskUsageBytes = Number(run(["du", "-s", "-B1", prefix]).split(/\s/)[0]);
	const apparentBytes = Number(run(["du", "-s", "--apparent-size", "-B1", prefix]).split(/\s/)[0]);
	const lock = await Bun.file(`${prefix}/package-lock.json`).json();
	const dependencies = Object.entries(lock.packages).filter(([path]) => path !== "")
		.map(([path, entry]) => {
			const p = entry as { version?: string; resolved?: string; integrity?: string; optional?: boolean };
			return { path, version: p.version, resolved: p.resolved, integrity: p.integrity, optional: p.optional,
				installed: Bun.file(`${prefix}/${path}/package.json`).size > 0 };
		});
	const versions: Record<string, string> = {};
	const bins: Record<string, string[]> = {
		typescript: ["tsc", "--version"], cspell: ["cspell", "--version"],
		"markdownlint-cli2": ["markdownlint-cli2", "--no-globs", "/tmp/app-t3code-markdown-probe.md"],
		"@biomejs/biome": ["biome", "--version"],
	};
	for (const name of scenario.label === "combined-node-tools" ? names : [scenario.label]) {
		const bin = bins[name];
		if (!bin) throw new Error(`No probe for ${name}`);
		versions[name] = run([`${prefix}/node_modules/.bin/${bin[0]}`, ...bin.slice(1)], { npm_config_offline: "true" });
	}
	measurements.push({ label: scenario.label, specifications: scenario.specs, diskUsageBytes, apparentBytes,
		installOutput: install, installedDependencyCount: dependencies.filter((p) => p.installed).length,
		dependencies, versionOrHelpProbes: versions });
}
await rm(prefix, { recursive: true, force: true });
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), architecture: process.arch,
	method: "npm installs exact versions into fresh temporary prefixes with --ignore-scripts --no-audit --no-fund; npm cache outside measured prefix. du reports allocated and apparent bytes including package-lock. Individual and combined scenarios start fresh. Runtime binaries exercised. Not an OCI layer measurement; no credit for unrelated baseline transitive dependencies.",
	nodeVersion: run(["node", "--version"]), npmVersion: run(["npm", "--version"]),
	bunVersion: Bun.version, registry, measurements }, null, 2));
