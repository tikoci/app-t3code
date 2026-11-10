/**
 * t3app (#45): the operator command. Argument errors and exit codes, the
 * ignored legacy T3CODE_* keys, the combined status and the background start
 * that keeps long verbs inside RouterOS's ~60 s /container/shell limit.
 * Runs on any host: nothing here installs anything.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSameProcess, LOG_ROTATE_BYTES, processStartTicks, startInBackground, startOnce } from "../lib/runtime.ts";
import { ignoredLegacyEnv, LEGACY_ENV, legacyEnvLine, main, USAGE } from "../lib/t3app.ts";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** Run main() with stdout and stderr captured. */
async function cli(argv: string[]) {
	const out: string[] = [];
	const err: string[] = [];
	const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		out.push(String(chunk));
		return true;
	});
	const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
		err.push(String(chunk));
		return true;
	});
	try {
		const code = await main(argv);
		return { code, out: out.join(""), err: err.join("") };
	} finally {
		stdout.mockRestore();
		stderr.mockRestore();
	}
}

describe("t3app command reference", () => {
	test("names every public command and the RouterOS path", () => {
		for (const command of ["status [--json]", "tools <status|install|prune|groups>", "providers <status|install>", "pairing [label]", "help"]) {
			expect(USAGE).toContain(`  ${command}`);
		}
		expect(USAGE).toContain('/container/shell app-t3code cmd="t3app status"');
		expect(USAGE).toContain("about 60 s");
		// init is the entrypoint's, not an operator command.
		expect(USAGE).not.toMatch(/^ {2}init\b/m);
	});

	test("help exits 0 on stdout; unknown commands and extra arguments exit 2 with usage on stderr", async () => {
		for (const argv of [["help"], ["--help"], ["-h"], ["status", "--help"], ["pairing", "--help"]]) {
			const { code, out, err } = await cli(argv);
			expect(code, argv.join(" ")).toBe(0);
			expect(out).toBe(USAGE);
			expect(err).toBe("");
		}
		for (const argv of [["bogus"], ["help", "extra"], ["status", "--bogus"], ["status", "json"], ["pairing", "a", "b"], ["pairing", "--label"], ["init", "now"], ["bogus", "--help"]]) {
			const { code, out, err } = await cli(argv);
			expect(code, argv.join(" ")).toBe(2);
			expect(out).toBe("");
			expect(err).toBe(USAGE);
		}
	});

	test("areas get their own reference and argument checks", async () => {
		expect((await cli(["tools", "help"])).out).toStartWith("t3app tools:");
		for (const argv of [["tools", "status", "--help"], ["tools", "install", "-h"], ["tools", "-h"], ["providers", "install", "--help"], ["providers", "help", "--help"]]) {
			const { code, out } = await cli(argv);
			expect(code, argv.join(" ")).toBe(0);
			expect(out).toStartWith(`t3app ${argv[0]}:`);
		}
		expect((await cli(["providers", "--help"])).out).toStartWith("t3app providers:");
		for (const argv of [
			["tools", "bogus"],
			["tools", "install", "now"],
			["tools", "install", "--wait", "--keep-trying"],
			["tools", "prune", "--all"],
			["tools", "bogus", "--help"],
			["providers", "bogus"],
			["providers", "install", "--all"],
			["providers", "init", "x"],
			["providers", "bogus", "--help"],
			// Help with anything extra is a usage error too (review on #51).
			["tools", "help", "extra"],
			["tools", "install", "now", "--help"],
			["tools", "-h", "status"],
			["providers", "help", "extra"],
			["status", "extra", "--help"],
			["pairing", "label", "--help"],
		]) {
			expect((await cli(argv)).code, argv.join(" ")).toBe(2);
		}
	});
});

describe("legacy T3CODE_* keys", () => {
	test("the three renamed keys, and nothing of upstream T3's", () => {
		expect(LEGACY_ENV).toEqual({ T3CODE_TOOL_GROUPS: "T3APP_TOOL_GROUPS", T3CODE_PROVIDERS: "T3APP_PROVIDERS", T3CODE_TOOLS_HOME: "T3APP_TOOLS_HOME" });
		expect(ignoredLegacyEnv({ T3CODE_HOME: "/data/.t3", T3CODE_PORT: "3773", T3APP_TOOL_GROUPS: "dev" })).toEqual([]);
		expect(legacyEnvLine({})).toBeNull();
	});

	test("a set legacy key (even empty) is named once, with its new name", () => {
		const env = { T3CODE_TOOL_GROUPS: "labs vpn dev", T3CODE_PROVIDERS: "", T3APP_TOOL_GROUPS: "dev" };
		expect(ignoredLegacyEnv(env)).toEqual([
			{ key: "T3CODE_TOOL_GROUPS", replacement: "T3APP_TOOL_GROUPS" },
			{ key: "T3CODE_PROVIDERS", replacement: "T3APP_PROVIDERS" },
		]);
		expect(legacyEnvLine(env)).toBe(
			"t3app: ignoring T3CODE_TOOL_GROUPS (now T3APP_TOOL_GROUPS), T3CODE_PROVIDERS (now T3APP_PROVIDERS); set the new key with /app/set environment= to keep a selection",
		);
	});

	test("the image reads only T3APP_*: the legacy names appear nowhere it ships but t3app.ts", () => {
		const shipped = ["Dockerfile", "docker-entrypoint.sh", "profile.sh", "app/t3code.tikapp.yaml", "app/t3code.tikappstore.yaml", "bin/t3app"];
		const libs = ["tool-catalog.ts", "tool-groups.ts", "tool-payloads.ts", "tool-status.ts", "providers.ts", "runtime.ts", "harnesses.ts"].map((f) => `lib/${f}`);
		for (const path of [...shipped, ...libs]) {
			for (const key of Object.keys(LEGACY_ENV)) expect(read(path), `${path} names ${key}`).not.toContain(key);
		}
	});
});

describe("t3app status", () => {
	let saved: Record<string, string | undefined>;
	beforeEach(() => {
		saved = { T3APP_TOOL_GROUPS: process.env["T3APP_TOOL_GROUPS"], T3APP_PROVIDERS: process.env["T3APP_PROVIDERS"], T3CODE_PROVIDERS: process.env["T3CODE_PROVIDERS"] };
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	test("--json carries both areas, the ignored keys and the logs", async () => {
		process.env["T3APP_TOOL_GROUPS"] = "vpn";
		process.env["T3APP_PROVIDERS"] = "codex";
		process.env["T3CODE_PROVIDERS"] = "claude";
		const { code, out } = await cli(["status", "--json"]);
		expect(code).toBe(0);
		const status = JSON.parse(out);
		expect(status.tools.selector).toMatchObject({ variable: "T3APP_TOOL_GROUPS", raw: "vpn", selected: ["vpn"] });
		expect(status.providers.selector).toMatchObject({ variable: "T3APP_PROVIDERS", raw: "codex", selected: ["codex"] });
		expect(status.ignoredEnv).toEqual([{ key: "T3CODE_PROVIDERS", replacement: "T3APP_PROVIDERS" }]);
		expect(status.logs.tools).toEndWith("/.local/state/t3code/tool-groups.log");
		expect(status.logs.providers).toEndWith("/.local/state/t3code/providers.log");
	});

	test("text shows both areas and the ignored key", async () => {
		process.env["T3APP_TOOL_GROUPS"] = "none";
		process.env["T3CODE_PROVIDERS"] = "claude";
		const { code, out } = await cli([]);
		expect(code).toBe(0);
		expect(out).toContain("== tools (t3app tools help)\nT3APP_TOOL_GROUPS=");
		expect(out).toContain("== providers (t3app providers help)\nT3APP_PROVIDERS=");
		expect(out).toContain("t3app: ignoring T3CODE_PROVIDERS (now T3APP_PROVIDERS)");
	});
});

describe("background start", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "t3app-bg-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("answers at once; the job outlives the caller and appends to the log", async () => {
		const log = join(dir, "state", "x.log");
		const done = join(dir, "done");
		const asked = Date.now();
		const pid = startInBackground("x install", ["sh", "-c", `sleep 2; echo job output; echo job error >&2; touch ${done}`], log);
		expect(Date.now() - asked).toBeLessThan(1000);
		expect(isSameProcess({ pid, startTicks: processStartTicks(pid) })).toBe(true);
		expect(readFileSync(log, "utf8")).toMatch(new RegExp(`t3app: x install started in the background \\(pid ${pid}\\)\\n$`));
		for (let i = 0; i < 100 && !existsSync(done); i++) await Bun.sleep(50);
		expect(readFileSync(log, "utf8")).toContain("job output\njob error\n");
	});

	test("rotates the log once it passes 1 MiB, like the entrypoint", () => {
		const log = join(dir, "x.log");
		writeFileSync(log, "x".repeat(LOG_ROTATE_BYTES + 1));
		startInBackground("x install", ["true"], log);
		expect(statSync(`${log}.1`).size).toBe(LOG_ROTATE_BYTES + 1);
		expect(readFileSync(log, "utf8")).toStartWith(new Date().toISOString().slice(0, 4));
	});

	test("startOnce: a second caller sees the first run, even before it takes any lock; a finished run starts again", async () => {
		const log = join(dir, "y.log");
		const argv = ["sh", "-c", "sleep 1"];
		const first = startOnce("y install", argv, log, () => null);
		const second = startOnce("y install", argv, log, () => null);
		expect(first.started).toBe(true);
		if (!first.started) return;
		expect(second).toMatchObject({ started: false, running: { pid: first.pid, command: "install" } });
		expect(readFileSync(log, "utf8").match(/started in the background/g)).toHaveLength(1);
		const id = { pid: first.pid, startTicks: processStartTicks(first.pid) };
		for (let i = 0; i < 100 && isSameProcess(id); i++) await Bun.sleep(50);
		const third = startOnce("y install", argv, log, () => null);
		expect(third.started).toBe(true);
		// What `busy` reports (the entrypoint's run, a lock holder) also stops a start.
		const holder = { pid: process.pid, startTicks: processStartTicks(process.pid), startedAt: "2026-11-10T00:00:00.000Z", command: "prune" };
		for (let i = 0; i < 100 && third.started && isSameProcess({ pid: third.pid, startTicks: processStartTicks(third.pid) }); i++) await Bun.sleep(50);
		expect(startOnce("y install", argv, log, () => holder)).toEqual({ started: false, running: holder });
	});
});

/**
 * `t3app tools install` and `t3app providers install` without --wait, in a
 * scratch home with empty selections: the background run does nothing and
 * exits, so only the start and the "already running" answers are exercised.
 */
describe("install starts in the background", () => {
	let home: string;
	let saved: Record<string, string | undefined>;
	const keys = ["HOME", "T3APP_TOOLS_HOME", "T3APP_TOOL_GROUPS", "T3APP_PROVIDERS"];
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "t3app-home-"));
		saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
		Object.assign(process.env, { HOME: home, T3APP_TOOLS_HOME: join(home, "tools"), T3APP_TOOL_GROUPS: "none", T3APP_PROVIDERS: "none" });
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(home, { recursive: true, force: true });
	});
	const me = () => ({ pid: process.pid, startTicks: processStartTicks(process.pid), startedAt: "2026-11-10T00:00:00.000Z" });
	/** Wait for the background run a start reported (its pid in the first line) to exit. */
	const waitForRun = async (out: string) => {
		const pid = Number(/\(pid (\d+)\)/.exec(out)?.[1]);
		const id = { pid, startTicks: processStartTicks(pid) };
		for (let i = 0; i < 200 && isSameProcess(id); i++) await Bun.sleep(50);
		expect(isSameProcess(id)).toBe(false);
	};

	test.skipIf(process.getuid?.() === 0)("tools: starts install --wait and says where it logs", async () => {
		const log = join(home, ".local/state/t3code/tool-groups.log");
		const { code, out } = await cli(["tools", "install"]);
		expect(code).toBe(0);
		expect(out).toMatch(/^t3app tools install: started in the background \(pid \d+\)\n/);
		expect(out).toContain(`log: ${log}\nprogress: t3app status\n`);
		expect(readFileSync(log, "utf8")).toContain("t3app: tools install started in the background");
		// The selection is empty, so the run takes the lock and finishes at once.
		await waitForRun(out);
		expect(readFileSync(join(home, "tools", "install.lock"), "utf8")).toBe("");
	});

	test.skipIf(process.getuid?.() === 0)("tools: an install holding the lock is reported, not started again; a prune is a failure", async () => {
		mkdirSync(join(home, "tools"), { recursive: true });
		writeFileSync(join(home, "tools", "install.lock"), JSON.stringify({ ...me(), command: "install" }));
		const running = await cli(["tools", "install"]);
		expect(running.code).toBe(0);
		expect(running.out).toStartWith(`t3app tools install: already running (pid ${process.pid}, since 2026-11-10T00:00:00.000Z)\n`);
		expect(existsSync(join(home, ".local/state/t3code/tool-groups.log"))).toBe(false);
		writeFileSync(join(home, "tools", "install.lock"), JSON.stringify({ ...me(), command: "prune" }));
		const pruning = await cli(["tools", "install"]);
		expect(pruning.code).toBe(1);
		expect(pruning.err).toContain(`a prune is running (pid ${process.pid})`);
	});

	test.skipIf(process.getuid?.() === 0)("tools: a --keep-trying run waiting out its back-off is no reason not to start (retry now)", async () => {
		mkdirSync(join(home, "tools"), { recursive: true });
		writeFileSync(join(home, "tools", "install.wait"), JSON.stringify({ ...me(), command: "install", waitingUntil: "2026-11-10T01:00:00.000Z" }));
		const { code, out } = await cli(["tools", "install"]);
		expect(code).toBe(0);
		expect(out).toContain("started in the background");
		await waitForRun(out);
	});

	test.skipIf(process.getuid?.() === 0)("providers: starts install --wait, or reports a running round", async () => {
		const log = join(home, ".local/state/t3code/providers.log");
		const started = await cli(["providers", "install"]);
		expect(started.code).toBe(0);
		expect(started.out).toMatch(/^t3app providers install: started in the background \(pid \d+\)\n/);
		expect(started.out).toContain(`log: ${log}\n`);
		await waitForRun(started.out);
		mkdirSync(join(home, ".local/state/t3code"), { recursive: true });
		writeFileSync(join(home, ".local/state/t3code/providers.json"), JSON.stringify({ providers: {}, installer: me() }));
		const running = await cli(["providers", "install"]);
		expect(running.code).toBe(0);
		expect(running.out).toStartWith(`t3app providers install: already running (pid ${process.pid}`);
		writeFileSync(join(home, ".local/state/t3code/providers.json"), JSON.stringify({ providers: {}, installer: { ...me(), waitingUntil: "2026-11-10T01:00:00.000Z" } }));
		const retry = await cli(["providers", "install"]);
		expect(retry.out).toContain("started in the background");
		await waitForRun(retry.out);
	});
});

describe("umask", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "t3app-umask-"));
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	// /container/shell starts commands with umask 0000 (RouterOS 7.25).
	test.skipIf(process.getuid?.() === 0)("t3app sets 022: a background install started under umask 0000 creates nothing world-writable", async () => {
		const env = { ...process.env, HOME: home, T3APP_TOOLS_HOME: join(home, "tools"), T3APP_TOOL_GROUPS: "none" };
		const proc = Bun.spawnSync(["sh", "-c", 'umask 000; exec "$0" "$1" tools install', process.execPath, join(ROOT, "lib/t3app.ts")], { env });
		expect(proc.exitCode, proc.stderr.toString()).toBe(0);
		const pid = Number(/\(pid (\d+)\)/.exec(proc.stdout.toString())?.[1]);
		const id = { pid, startTicks: processStartTicks(pid) };
		for (let i = 0; i < 200 && isSameProcess(id); i++) await Bun.sleep(50);
		const mode = (path: string) => statSync(join(home, path)).mode & 0o777;
		expect(mode(".local/state/t3code")).toBe(0o755);
		expect(mode(".local/state/t3code/tool-groups.log")).toBe(0o644);
		expect(mode("tools")).toBe(0o755);
		expect(mode("tools/install.lock")).toBe(0o644);
	});
});
