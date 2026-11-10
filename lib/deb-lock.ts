// Image build only (Dockerfile, as root, after apt-get update): pin each deb
// group's package closure from apt metadata into
// <spec-dir>/<group>/debs.lock.json. Not an operator command.
//
//   bun /usr/local/lib/t3app/deb-lock.ts [--spec-dir <dir>]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEB_LOCK_FILE, resolveDebLock } from "./deb-payloads.ts";
import { GROUPS, PAYLOAD_SPEC_DIR } from "./tool-catalog.ts";

const USAGE = "usage: bun deb-lock.ts [--spec-dir <dir>]\n";

/** Returns the process exit code. */
export function main(argv: string[]): number {
	let specDir = PAYLOAD_SPEC_DIR;
	if (argv[0] === "--spec-dir" && argv[1] && argv.length === 2) specDir = argv[1];
	else if (argv.length) {
		process.stderr.write(USAGE);
		return 2;
	}
	const exec = (cmd: string[]) => {
		const proc = Bun.spawnSync(cmd, { env: { ...process.env, LC_ALL: "C" } });
		if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited ${proc.exitCode}: ${proc.stderr.toString().trim()}`);
		return proc.stdout.toString();
	};
	for (const group of GROUPS.filter((g) => g.delivery === "deb")) {
		const lock = resolveDebLock(group.name, group.packages, exec, readFileSync("/etc/os-release", "utf8"));
		const path = join(specDir, group.name, DEB_LOCK_FILE);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);
		const mib = (n: number) => (n / 1024 / 1024).toFixed(1);
		const download = lock.packages.reduce((s, p) => s + p.size, 0);
		const installed = lock.packages.reduce((s, p) => s + p.installedSize, 0);
		process.stdout.write(`${group.name}: ${lock.packages.length} packages for ${lock.arch} ${lock.distro}, ${mib(download)} MiB download, ${mib(installed)} MiB unpacked -> ${path}\n`);
		for (const up of lock.imageUpgrades ?? []) {
			process.stdout.write(`${group.name}: warning: apt wants ${up.name} ${up.installed} -> ${up.candidate}; not extracted (the image copy wins). Rebuild the image if the tools need it.\n`);
		}
	}
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
