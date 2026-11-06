/** Persistent npm payload lifecycle (issue #5 slice 2), offline with a fake npm. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatus, GROUPS, type Probe } from "../scripts/tool-groups.ts";
import { activate, activateIfIdle, type Compat, installGroups, type PayloadEnv, processStartTicks, prunePayloads, readState } from "../scripts/tool-payloads.ts";

const SPEC = join(import.meta.dir, "..", "scripts", "groups");
const dev = GROUPS.find((g) => g.name === "dev");
if (!dev) throw new Error("dev group missing");
// The npm group alone: these tests cover the shared lifecycle with npm.
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
# Hold the install open until the test releases it (lock tests).
while [ -e "${dir}/hold" ]; do sleep 0.05; done
prefix=""; while [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && prefix="$2"; shift; done
mkdir -p "$prefix/node_modules/.bin"
for b in tsc cspell markdownlint-cli2 biome; do
  printf '#!/bin/sh\\necho "%s fake 1.0"\\n' "$b" > "$prefix/node_modules/.bin/$b"
  chmod +x "$prefix/node_modules/.bin/$b"
done
# A broken native binary: installs, but its version probe fails.
[ -e "${dir}/badbin" ] && printf '#!/bin/sh\\necho "exec format error" >&2\\nexit 126\\n' > "$prefix/node_modules/.bin/biome"
exit 0
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
		debCompat: () => null,
		npm: [fakeNpm(tmp)],
		dpkgDeb: ["false"],
		fetch: async () => new Response("offline", { status: 503 }),
		snapshotBase: "http://snapshot.invalid",
		imageRoot: join(tmp, "image"),
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
		expect(devState()?.payload?.installer).toBeNull();
		expect(devState()?.state).toBe("ready");
	});

	test("a failing version probe never creates or activates the payload; a failed refresh keeps the previous one", async () => {
		writeFileSync(join(tmp, "badbin"), "");
		const first = await installGroups(npmGroups, ["dev"], env);
		expect(first.results["dev"]?.state).toBe("failed");
		expect(first.results["dev"]?.error).toContain("biome --version exited 126");
		expect(readdirSync(join(env.root, "groups", "dev"))).toEqual([]);
		expect(existsSync(join(env.root, "bin", "biome"))).toBe(false);
		expect(devState()?.state).toBe("failed");

		rmSync(join(tmp, "badbin"));
		await installGroups(npmGroups, ["dev"], env);
		const good = devState()?.payload?.active;
		expect(good).toBeString();

		compat = { ...compat, nodeAbi: "141" };
		writeFileSync(join(tmp, "badbin"), "");
		const refresh = await installGroups(npmGroups, ["dev"], env);
		expect(refresh.results["dev"]?.state).toBe("failed");
		const status = devState();
		expect(status?.state).toBe("ready");
		expect(status?.payload).toMatchObject({ active: good, stale: true, installed: [good] });
		expect(Bun.spawnSync([join(env.root, "bin", "biome")]).stdout.toString().trim()).toBe("biome fake 1.0");
	});

	test("a payload built for another CPU is never linked or reported active", async () => {
		await installGroups(npmGroups, ["dev"], env);
		compat = { ...compat, arch: "arm64" }; // the same home on an arm64 router
		expect(activate(npmGroups, ["dev"], env)).toEqual(["dev"]);
		expect(existsSync(join(env.root, "bin", "tsc"))).toBe(false);
		const status = devState();
		expect(status?.payload?.active).toBeNull();
		expect(status?.state).toBe("pending");
		await installGroups(npmGroups, ["dev"], env);
		expect(devState()?.payload?.active).toStartWith("arm64-");
	});

	test("a separate live installer holds the lock; install and prune leave it alone", async () => {
		// A real second process installing (held open by the fake npm).
		const script = join(tmp, "child.ts");
		writeFileSync(
			script,
			`import { installGroups } from ${JSON.stringify(join(import.meta.dir, "..", "scripts", "tool-payloads.ts"))};
import { GROUPS } from ${JSON.stringify(join(import.meta.dir, "..", "scripts", "tool-groups.ts"))};
const env = JSON.parse(process.argv[2]);
const r = await installGroups(GROUPS.filter((g) => g.delivery === "npm"), ["dev"], {
	...env, compat: () => env.compatValue, sleep: async () => {}, log: () => {}, freeBytes: () => 10 * 1024 ** 3,
});
process.exit(r.locked ? 0 : 3);
`,
		);
		writeFileSync(join(tmp, "hold"), "");
		const child = Bun.spawn(["bun", script, JSON.stringify({ ...env, compatValue: compat })], { stdout: "inherit", stderr: "inherit" });
		const lock = join(env.root, "install.lock");
		for (let i = 0; i < 200 && !existsSync(join(tmp, "npm-calls")); i++) await Bun.sleep(25);
		expect(JSON.parse(readFileSync(lock, "utf8"))).toMatchObject({ pid: child.pid, command: "install" });
		expect(devState()?.state).toBe("installing");

		const second = await installGroups(npmGroups, ["dev"], env);
		expect(second.locked).toBe(false);
		await expect(prunePayloads(npmGroups, [], env)).rejects.toThrow("installer is running");
		expect(JSON.parse(readFileSync(lock, "utf8"))).toMatchObject({ pid: child.pid, child: { pid: expect.any(Number) } });

		rmSync(join(tmp, "hold"));
		expect(await child.exited).toBe(0);
		expect(devState()?.payload?.installer).toBeNull();
		expect(devState()?.state).toBe("ready");
		expect(npmCalls()).toBe(1);
	});

	test("the kernel lock excludes holders of any kind; a stale record or recycled pid does not", async () => {
		mkdirSync(env.root, { recursive: true });
		const lock = join(env.root, "install.lock");
		writeFileSync(lock, "");
		// Another process (here flock(1), standing in for a prune) holds the lock.
		const holder = Bun.spawn(["flock", "-o", lock, "sleep", "30"]);
		try {
			for (let i = 0; i < 100 && Bun.spawnSync(["flock", "-n", lock, "true"]).exitCode === 0; i++) await Bun.sleep(20);
			expect((await installGroups(npmGroups, ["dev"], env)).locked).toBe(false);
			await expect(prunePayloads(npmGroups, [], env)).rejects.toThrow("installer is running");
			expect(npmCalls()).toBe(0);
		} finally {
			holder.kill();
			await holder.exited;
		}
		// After a container restart the new installer can get the dead holder's
		// pid: same pid, different start time. The record is not a lock.
		writeFileSync(lock, JSON.stringify({ pid: process.pid, startTicks: "1", command: "install", startedAt: "earlier boot" }));
		expect(devState()?.payload?.installer).toBeNull();
		const result = await installGroups(npmGroups, ["dev"], env);
		expect(result.locked).toBe(true);
		expect(devState()?.state).toBe("ready");
		expect(readFileSync(lock, "utf8")).toBe("");
	});

	test("concurrent installers in one process: exactly one proceeds", async () => {
		writeFileSync(join(tmp, "hold"), "");
		const first = installGroups(npmGroups, ["dev"], env);
		for (let i = 0; i < 200 && !existsSync(join(tmp, "npm-calls")); i++) await Bun.sleep(25);
		const results = await Promise.all([installGroups(npmGroups, ["dev"], env), installGroups(npmGroups, ["dev"], env)]);
		expect(results.map((r) => r.locked)).toEqual([false, false]);
		rmSync(join(tmp, "hold"));
		expect((await first).locked).toBe(true);
		expect(npmCalls()).toBe(1);
	});

	test("an npm child orphaned by a killed installer is stopped before its staging is reclaimed", async () => {
		const script = join(tmp, "child.ts");
		writeFileSync(
			script,
			`import { installGroups } from ${JSON.stringify(join(import.meta.dir, "..", "scripts", "tool-payloads.ts"))};
import { GROUPS } from ${JSON.stringify(join(import.meta.dir, "..", "scripts", "tool-groups.ts"))};
const env = JSON.parse(process.argv[2]);
await installGroups(GROUPS.filter((g) => g.delivery === "npm"), ["dev"], {
	...env, compat: () => env.compatValue, sleep: async () => {}, log: () => {}, freeBytes: () => 10 * 1024 ** 3,
});
`,
		);
		writeFileSync(join(tmp, "hold"), "");
		const child = Bun.spawn(["bun", script, JSON.stringify({ ...env, compatValue: compat })]);
		const lock = join(env.root, "install.lock");
		let npm: { pid: number } | undefined;
		for (let i = 0; i < 200 && !npm; i++) {
			await Bun.sleep(25);
			try {
				npm = JSON.parse(readFileSync(lock, "utf8")).child;
			} catch {}
		}
		expect(npm?.pid).toBeNumber();
		child.kill("SIGKILL"); // the installer dies; its npm keeps running
		await child.exited;
		expect(processStartTicks(npm?.pid as number)).not.toBeNull();

		// The hold file is still there: only stopping the orphan lets this finish.
		const logs: string[] = [];
		env.log = (line) => logs.push(line);
		const removeHold = setTimeout(() => rmSync(join(tmp, "hold"), { force: true }), 3000);
		const result = await installGroups(npmGroups, ["dev"], env);
		clearTimeout(removeHold);
		expect(result.locked).toBe(true);
		expect(logs.some((line) => line.includes(`stopping npm (pid ${npm?.pid})`))).toBe(true);
		expect(processStartTicks(npm?.pid as number)).toBeNull();
		expect(readdirSync(join(env.root, "groups", "dev")).filter((n) => n.startsWith(".staging-"))).toEqual([]);
		expect(result.results["dev"]?.state).toBe("ready");
	});

	test("startup activation never races install/prune: it defers while the lock is held", async () => {
		await installGroups(npmGroups, ["dev"], env);
		const lock = join(env.root, "install.lock");
		const holder = Bun.spawn(["flock", "-o", lock, "sleep", "30"]);
		try {
			for (let i = 0; i < 100 && Bun.spawnSync(["flock", "-n", lock, "true"]).exitCode === 0; i++) await Bun.sleep(20);
			expect(await activateIfIdle(npmGroups, [], env)).toBeNull();
			expect(existsSync(join(env.root, "bin", "tsc"))).toBe(true); // untouched
		} finally {
			holder.kill();
			await holder.exited;
		}
		expect(await activateIfIdle(npmGroups, [], env)).toEqual([]);
		expect(existsSync(join(env.root, "bin", "tsc"))).toBe(false);
		expect(await activateIfIdle(npmGroups, ["dev"], env)).toEqual([]);
		expect(devState()?.state).toBe("ready");
	});

	test("an unusable Node runtime never reports a payload active or keeps its shims", async () => {
		await installGroups(npmGroups, ["dev"], env);
		const working = compat;
		env.compat = () => null;
		expect(activate(npmGroups, ["dev"], env)).toEqual(["dev"]);
		expect(existsSync(join(env.root, "bin", "tsc"))).toBe(false);
		const status = devState();
		expect(status?.payload?.active).toBeNull();
		expect(status?.payload?.desiredError).toContain("node is not usable");
		expect(status?.state).not.toBe("ready");
		// Node comes back: the same payload is relinked offline.
		env.compat = () => working;
		expect(activate(npmGroups, ["dev"], env)).toEqual([]);
		expect(npmCalls()).toBe(1);
	});

	test("interrupted installs of deselected groups are cleaned too", async () => {
		const staging = join(env.root, "groups", "dev", ".staging-x64-abi137-dead-99");
		mkdirSync(staging, { recursive: true });
		await installGroups(npmGroups, [], env);
		expect(existsSync(staging)).toBe(false);
		expect(npmCalls()).toBe(0);
	});

	test("prune deletes payloads no selected group uses", async () => {
		await installGroups(npmGroups, ["dev"], env);
		expect(await prunePayloads(npmGroups, ["dev"], env)).toEqual([]);
		const removed = await prunePayloads(npmGroups, [], env);
		expect(removed).toHaveLength(1);
		expect(existsSync(join(env.root, "groups", "dev", "current"))).toBe(false);
		expect(() => readlinkSync(join(env.root, "bin", "tsc"))).toThrow();
		expect(devState()?.state).toBe("pending");
	});
});
