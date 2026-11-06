/** Persistent npm payload lifecycle (issue #5 slice 2), offline with a fake npm. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatus, GROUPS, type Probe } from "../scripts/tool-groups.ts";
import { activate, type Compat, installGroups, type PayloadEnv, prunePayloads, readState } from "../scripts/tool-payloads.ts";

const SPEC = join(import.meta.dir, "..", "scripts", "groups");
const dev = GROUPS.find((g) => g.name === "dev");
if (!dev) throw new Error("dev group missing");
const npmGroups = GROUPS.filter((g) => g.delivery === "npm");
const nothing: Probe = { which: () => null, exists: () => false, library: () => null };

let tmp: string;
let env: PayloadEnv;
let compat: Compat;

/** A fake `npm ci --prefix <dir>` that writes executable bins and counts calls. */
function fakeNpm(dir: string): string {
	const path = join(dir, "fake-npm");
	writeFileSync(
		path,
		`#!/bin/sh
set -eu
echo x >> "${dir}/npm-calls"
[ -e "${dir}/fail" ] && { echo "registry unreachable" >&2; exit 1; }
prefix=""; while [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && prefix="$2"; shift; done
mkdir -p "$prefix/node_modules/.bin"
for b in tsc cspell markdownlint-cli2 biome; do
  printf '#!/bin/sh\\necho "%s fake 1.0"\\n' "$b" > "$prefix/node_modules/.bin/$b"
  chmod +x "$prefix/node_modules/.bin/$b"
done
`,
	);
	chmodSync(path, 0o755);
	return path;
}

const npmCalls = () => (existsSync(join(tmp, "npm-calls")) ? readFileSync(join(tmp, "npm-calls"), "utf8").trim().split("\n").length : 0);
const devState = () => buildStatus("dev", nothing, "/nonexistent", env).groups.find((g) => g.name === "dev");

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "t3code-payloads-"));
	cpSync(SPEC, join(tmp, "spec"), { recursive: true });
	compat = { platform: "linux", arch: "x64", nodeAbi: "137", node: "v24.0.0" };
	env = {
		root: join(tmp, "home", ".local/share/t3code-tools"),
		specDir: join(tmp, "spec"),
		compat: () => compat,
		npm: [fakeNpm(tmp)],
		sleep: async () => {},
		log: () => {},
		freeBytes: () => 10 * 1024 ** 3,
		backoffMs: [0, 0],
		installTimeoutMs: 30_000,
	};
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("npm payload groups", () => {
	test("the dev group ships a pinned lockfile in the image spec dir", () => {
		const lock = JSON.parse(readFileSync(join(SPEC, "dev", "package-lock.json"), "utf8"));
		const pkg = JSON.parse(readFileSync(join(SPEC, "dev", "package.json"), "utf8"));
		expect(Object.keys(pkg.dependencies).sort()).toEqual([...(dev.npm ?? [])].sort());
		for (const [name, version] of Object.entries(pkg.dependencies)) {
			expect(version).toMatch(/^\d+\.\d+\.\d+$/);
			expect(lock.packages[`node_modules/${name}`].version).toBe(version);
			expect(lock.packages[`node_modules/${name}`].integrity).toStartWith("sha512-");
		}
		// Native binaries for both shipped architectures are in the lockfile.
		expect(lock.packages["node_modules/@biomejs/cli-linux-x64"]).toBeDefined();
		expect(lock.packages["node_modules/@biomejs/cli-linux-arm64"]).toBeDefined();
	});

	test("selected but not installed is pending, never ready from PATH", () => {
		expect(devState()?.state).toBe("pending");
		const everything: Probe = { which: (c) => `/usr/bin/${c}`, exists: () => true, library: (l) => `/lib/${l}` };
		expect(buildStatus("dev", everything, "/nonexistent", env).groups.find((g) => g.name === "dev")?.state).toBe("pending");
		expect(buildStatus("none", nothing, "/nonexistent", env).groups.find((g) => g.name === "dev")?.state).toBe("not-selected");
	});

	test("installs, verifies, links shims and reuses the payload without npm", async () => {
		const result = await installGroups(npmGroups, ["dev"], env);
		expect(result.results["dev"]?.state).toBe("ready");
		const status = devState();
		expect(status?.state).toBe("ready");
		expect(status?.present).toBe(true);
		expect(status?.payload?.activeVersions).toEqual({
			tsc: "tsc fake 1.0",
			cspell: "cspell fake 1.0",
			"markdownlint-cli2": "markdownlint-cli2 fake 1.0",
			biome: "biome fake 1.0",
		});
		const tsc = Bun.spawnSync([join(env.root, "bin", "tsc")]);
		expect(tsc.stdout.toString().trim()).toBe("tsc fake 1.0");
		expect(npmCalls()).toBe(1);

		// A replacement container with the same home: activation alone, offline.
		expect(activate(npmGroups, ["dev"], env)).toEqual([]);
		await installGroups(npmGroups, ["dev"], env);
		expect(npmCalls()).toBe(1);
	});

	test("deselecting unlinks shims but keeps the payload; reselecting relinks offline", async () => {
		await installGroups(npmGroups, ["dev"], env);
		activate(npmGroups, [], env);
		expect(existsSync(join(env.root, "bin", "tsc"))).toBe(false);
		const off = buildStatus("none", nothing, "/nonexistent", env).groups.find((g) => g.name === "dev");
		expect(off?.state).toBe("not-selected");
		expect(off?.payload?.installed).toHaveLength(1);
		expect(activate(npmGroups, ["dev"], env)).toEqual([]);
		expect(devState()?.state).toBe("ready");
		expect(npmCalls()).toBe(1);
	});

	test("a lockfile or ABI change refreshes; the old payload serves until the new one verifies", async () => {
		await installGroups(npmGroups, ["dev"], env);
		const first = devState()?.payload?.active;

		compat = { ...compat, nodeAbi: "141" };
		expect(activate(npmGroups, ["dev"], env)).toEqual(["dev"]);
		let status = devState();
		expect(status?.state).toBe("ready");
		expect(status?.payload?.stale).toBe(true);

		writeFileSync(join(tmp, "fail"), "");
		const failed = await installGroups(npmGroups, ["dev"], env);
		expect(failed.results["dev"]).toMatchObject({ state: "failed", attempt: 3 });
		expect(npmCalls()).toBe(4); // 1 + three bounded attempts
		status = devState();
		expect(status?.state).toBe("ready"); // previous payload still active
		expect(status?.payload).toMatchObject({ active: first, stale: true, last: { state: "failed" } });

		rmSync(join(tmp, "fail"));
		await installGroups(npmGroups, ["dev"], env);
		status = devState();
		expect(status?.payload?.stale).toBe(false);
		expect(status?.payload?.active).not.toBe(first);
		expect(status?.payload?.installed.sort()).toEqual([first as string, status?.payload?.active as string].sort());

		// A third payload prunes all but the active one and the one before it.
		writeFileSync(join(env.specDir, "dev", "package-lock.json"), `${readFileSync(join(env.specDir, "dev", "package-lock.json"), "utf8")}\n`);
		const second = status?.payload?.active;
		await installGroups(npmGroups, ["dev"], env);
		status = devState();
		expect(status?.payload?.installed).toHaveLength(2);
		expect(status?.payload?.installed).toContain(second as string);
		expect(status?.payload?.installed).not.toContain(first as string);
	});

	test("a failed first install reports failed with the error, and core is untouched", async () => {
		writeFileSync(join(tmp, "fail"), "");
		await installGroups(npmGroups, ["dev"], env);
		const status = devState();
		expect(status?.state).toBe("failed");
		expect(status?.payload?.last?.error).toContain("registry unreachable");
	});

	test("low disk fails without downloading or deleting anything", async () => {
		env.freeBytes = () => 50 * 1024 * 1024;
		await installGroups(npmGroups, ["dev"], env);
		expect(npmCalls()).toBe(0);
		expect(readState(env)["dev"]).toMatchObject({ state: "failed", permanent: true });
		expect(readState(env)["dev"]?.error).toContain("low disk");
		expect(devState()?.state).toBe("failed");
	});

	test("recovers from an interrupted install and a dead installer's lock", async () => {
		const staging = join(env.root, "groups", "dev", ".staging-x64-abi137-dead-424242");
		mkdirSync(join(staging, "node_modules"), { recursive: true });
		writeFileSync(join(env.root, "install.lock"), JSON.stringify({ pid: 2 ** 22 + 7, startedAt: "2026-01-01T00:00:00Z" }));
		expect(devState()?.payload?.installer).toBeNull();
		const result = await installGroups(npmGroups, ["dev"], env);
		expect(result.locked).toBe(true);
		expect(existsSync(staging)).toBe(false);
		expect(existsSync(join(env.root, "install.lock"))).toBe(false);
		expect(devState()?.state).toBe("ready");
	});

	test("a live installer holds the lock; a second one leaves it alone", async () => {
		mkdirSync(env.root, { recursive: true });
		writeFileSync(join(env.root, "install.lock"), JSON.stringify({ pid: process.pid, startedAt: "now" }));
		const result = await installGroups(npmGroups, ["dev"], env);
		expect(result.locked).toBe(false);
		expect(npmCalls()).toBe(0);
		expect(() => prunePayloads(npmGroups, [], env)).toThrow("installer is running");
	});

	test("prune deletes payloads no selected group uses", async () => {
		await installGroups(npmGroups, ["dev"], env);
		expect(prunePayloads(npmGroups, ["dev"], env)).toEqual([]);
		const removed = prunePayloads(npmGroups, [], env);
		expect(removed).toHaveLength(1);
		expect(existsSync(join(env.root, "groups", "dev", "current"))).toBe(false);
		expect(() => readlinkSync(join(env.root, "bin", "tsc"))).toThrow();
		expect(devState()?.state).toBe("pending");
	});
});
