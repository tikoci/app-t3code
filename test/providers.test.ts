/**
 * T3APP_PROVIDERS (#13): selection, status and the background installer,
 * with the install steps faked. The docker replacement test covers a real
 * npm install of Codex in the image.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "js-yaml";
import { HARNESSES } from "../lib/harnesses.ts";
import { buildProviderStatus, DEFAULT_PROVIDERS, formatProviderStatus, type InstallEnv, installProviders, installSteps, parseProviders, PROVIDER_TOKENS, PROVIDERS, readProviderState, requiredBytes, USAGE } from "../lib/providers.ts";
import { isSameProcess, kernelFlock, LOCK_EX, LOCK_NB, processStartTicks, stateDir } from "../lib/runtime.ts";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
function provider(token: string) {
	const found = PROVIDERS.find((p) => p.token === token);
	if (!found) throw new Error(`no provider ${token}`);
	return found;
}

describe("T3APP_PROVIDERS selection", () => {
	test("tokens are the eight providers in T3's main Add provider list", () => {
		expect([...PROVIDER_TOKENS].sort()).toEqual(["antigravity", "claude", "codex", "cursor", "grok", "muse", "opencode", "pi"]);
	});

	test("accepts space, + and comma separators, case-insensitively, in catalog order", () => {
		for (const raw of ["opencode codex", "opencode+codex", "OpenCode,Codex", " codex , opencode codex"]) {
			const selection = parseProviders(raw);
			expect(selection.selected).toEqual(["codex", "opencode"]);
			expect(selection.warnings).toEqual([]);
		}
	});

	test("unset and empty select the default; none installs nothing; there is no all", () => {
		for (const raw of [undefined, null, "", "  "]) {
			expect(parseProviders(raw)).toMatchObject({ selected: ["codex", "claude"], defaulted: true, warnings: [] });
		}
		expect(DEFAULT_PROVIDERS).toBe("claude codex");
		expect(parseProviders("none").selected).toEqual([]);
		expect(parseProviders("none claude").selected).toEqual(["claude"]);
		expect(parseProviders("none claude").warnings[0]).toContain('"none" combined');
		expect(parseProviders("all")).toMatchObject({ selected: [], unknown: ["all"] });
	});

	test("drivers outside the main list are named, not installed", () => {
		const selection = parseProviders("claude kiro fx bogus");
		expect(selection.selected).toEqual(["claude"]);
		expect(selection.unknown).toEqual(["kiro", "fx", "bogus"]);
		expect(selection.warnings[0]).toContain("Kiro is not installed by this image");
		expect(selection.warnings[0]).toContain("open an issue");
		expect(selection.warnings[2]).toContain('unknown provider "bogus"');
	});

	test("the image ENV, both YAML files and the README ship the same default", () => {
		const env = /^ENV T3APP_PROVIDERS="([^"]*)"$/m.exec(read("Dockerfile"))?.[1];
		expect(env).toBe(DEFAULT_PROVIDERS);
		const app = YAML.load(read("app/t3code.tikapp.yaml")) as { services: { t3code: { environment: Record<string, string> } } };
		expect(app.services.t3code.environment.T3APP_PROVIDERS).toBe(DEFAULT_PROVIDERS);
		const store = (YAML.load(read("app/t3code.tikappstore.yaml")) as { name: string; services: { t3code: { environment: Record<string, string> } } }[]).find(
			(d) => d.name === "t3code",
		);
		expect(store?.services.t3code.environment.T3APP_PROVIDERS).toBe(DEFAULT_PROVIDERS);
		expect(read("README.md")).toContain(`| \`T3APP_PROVIDERS\` | \`${DEFAULT_PROVIDERS}\``);
	});

	test("no provider CLI is baked into the image", () => {
		const dockerfile = read("Dockerfile");
		for (const pkg of ["@openai/codex", "opencode-ai", "pi-coding-agent", "x.ai/cli", "dev.meta.ai"]) expect(dockerfile).not.toContain(pkg);
		expect(dockerfile).toContain("COPY lib /usr/local/lib/t3app");
	});

	test("help names every token and the README documents every one", () => {
		const readme = read("README.md");
		for (const token of PROVIDER_TOKENS) {
			expect(USAGE).toContain(token);
			expect(readme).toContain(`| \`${token}\` |`);
		}
	});
});

describe("install steps", () => {
	test("npm installs go global, so NPM_CONFIG_PREFIX (/data/.local) decides where", () => {
		expect(installSteps(provider("codex"), "/s")).toEqual([
			{ argv: ["npm", "install", "--global", "--no-fund", "--no-audit", "@openai/codex"], env: {} },
		]);
		// T3's own hint for Pi: npm install -g --ignore-scripts @earendil-works/pi-coding-agent
		expect(installSteps(provider("pi"), "/s")[0]?.argv).toEqual(["npm", "install", "--global", "--no-fund", "--no-audit", "--ignore-scripts", "@earendil-works/pi-coding-agent"]);
	});

	test("vendor installers are fetched over HTTPS only, then run with bash", () => {
		const [fetch, run] = installSteps(provider("muse"), "/s");
		expect(fetch?.argv).toEqual(["curl", "-fsSL", "--proto", "=https", "--retry", "3", "--create-dirs", "-o", "/s/downloads/muse-install.sh", "https://dev.meta.ai/install.sh"]);
		expect(run).toEqual({ argv: ["bash", "/s/downloads/muse-install.sh"], env: { MUSE_NO_MODIFY_PATH: "1" } });
	});

	test("Claude uses the image's installer; Cursor and Antigravity install nothing", () => {
		expect(installSteps(provider("claude"), "/s")).toEqual([{ argv: ["install-claude-code"], env: {} }]);
		expect(installSteps(provider("cursor"), "/s")).toEqual([]);
		expect(installSteps(provider("antigravity"), "/s")).toEqual([]);
	});

	test("every selectable provider says how it installs; the others have no token", () => {
		for (const [driver, harness] of Object.entries(HARNESSES)) {
			expect({ driver, ok: Boolean(harness.token) === Boolean(harness.install) }).toEqual({ driver, ok: true });
		}
	});
});

describe("installer", () => {
	let dir: string;
	let onPath: Set<string>;
	let ran: string[][];
	let env: InstallEnv;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "providers-"));
		onPath = new Set();
		ran = [];
		env = {
			dir,
			which: (c) => (onPath.has(c) ? `/data/.local/bin/${c}` : null),
			backoffMs: [1, 1],
			sleep: async () => {},
			log: () => {},
			freeBytes: () => 64 * 1024 ** 3,
			run: async (argv) => {
				ran.push(argv);
				if (argv[0] === "npm") onPath.add(argv.at(-1) === "@openai/codex" ? "codex" : "opencode");
				if (argv[0] === "install-claude-code") onPath.add("claude");
				return 0;
			},
		};
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("installs only missing CLIs; a CLI already on PATH is never touched", async () => {
		onPath.add("claude");
		expect(await installProviders(["claude", "codex", "cursor"], env)).toBe(0);
		expect(ran).toEqual([["npm", "install", "--global", "--no-fund", "--no-audit", "@openai/codex"]]);
		const state = readProviderState(dir);
		expect(state.providers.codex?.state).toBe("ready");
		expect(state.providers.claude?.state).toBe("ready");
		expect(state.installer).toBeUndefined();
		ran = [];
		expect(await installProviders(["claude", "codex"], env)).toBe(0);
		expect(ran).toEqual([]);
	});

	test("retries a failure each round, then reports it", async () => {
		env.run = async (argv) => {
			ran.push(argv);
			return 1;
		};
		expect(await installProviders(["opencode"], env)).toBe(1);
		expect(ran.length).toBe(3);
		const state = readProviderState(dir);
		expect(state.providers.opencode).toMatchObject({ state: "failed", error: "npm exited 1" });
		expect(state.installer).toBeUndefined();
		const status = buildProviderStatus("opencode", env.which, dir);
		expect(status.providers.find((p) => p.token === "opencode")?.state).toBe("failed");
		expect(formatProviderStatus(status)).toContain("last error: npm exited 1");
	});

	test("an installer that exits 0 without putting the CLI on PATH failed", async () => {
		env.run = async () => 0;
		expect(await installProviders(["codex"], { ...env, backoffMs: [] })).toBe(1);
		expect(readProviderState(dir).providers.codex?.error).toBe("installed, but no codex on PATH");
	});

	test("a failed download step stops before running the vendor script", async () => {
		env.run = async (argv) => {
			ran.push(argv);
			return argv[0] === "curl" ? 22 : 0;
		};
		expect(await installProviders(["grok"], { ...env, backoffMs: [] })).toBe(1);
		expect(ran.map((argv) => argv[0])).toEqual(["curl"]);
		expect(readProviderState(dir).providers.grok?.error).toBe("curl exited 22");
	});

	test("a terminal install while another installer holds the lock exits 1 and runs nothing", async () => {
		mkdirSync(dir, { recursive: true });
		const fd = openSync(join(dir, "providers.lock"), "a+");
		try {
			expect(kernelFlock(fd, LOCK_EX | LOCK_NB)).toBe(true);
			expect(await installProviders(["codex"], { ...env, backoffMs: [] })).toBe(1);
			expect(ran).toEqual([]);
		} finally {
			closeSync(fd);
		}
		expect(await installProviders(["codex"], env)).toBe(0);
	});

	test("a background installer waits out a busy lock without touching the holder's record", async () => {
		const holder = { pid: 4242, startTicks: "1", startedAt: "2026-11-09T00:00:00.000Z" };
		writeFileSync(join(dir, "providers.json"), JSON.stringify({ installer: holder, providers: { codex: { state: "installing", at: holder.startedAt } } }));
		const fd = openSync(join(dir, "providers.lock"), "a+");
		const seen: unknown[] = [];
		try {
			expect(kernelFlock(fd, LOCK_EX | LOCK_NB)).toBe(true);
			const background = { ...env, backoffMs: [1, 1, 1], sleep: async () => void seen.push(readProviderState(dir)) };
			expect(await installProviders(["codex"], background)).toBe(1);
		} finally {
			closeSync(fd);
		}
		expect(ran).toEqual([]);
		expect(seen).toHaveLength(3);
		for (const state of seen) expect(state).toEqual({ installer: holder, providers: { codex: { state: "installing", at: holder.startedAt } } });
	});

	test("a step that cannot start fails that provider; the round goes on to the next", async () => {
		env.run = async (argv) => {
			ran.push(argv);
			if (argv[0] === "npm") throw new Error("Executable not found in $PATH: \"npm\"");
			onPath.add("claude");
			return 0;
		};
		expect(await installProviders(["claude", "codex"], { ...env, backoffMs: [] })).toBe(1);
		const state = readProviderState(dir);
		expect(state.providers.codex).toMatchObject({ state: "failed", error: 'could not start npm: Executable not found in $PATH: "npm"' });
		expect(state.providers.claude?.state).toBe("ready");
		expect(state.installer).toBeUndefined();
	});

	test("an install step left running by an installer that died is stopped before the next install", async () => {
		const orphan = Bun.spawn(["sleep", "60"]);
		const child = { pid: orphan.pid, startTicks: processStartTicks(orphan.pid) };
		writeFileSync(join(dir, "providers.json"), JSON.stringify({ installer: { pid: 999_999, startTicks: null, startedAt: "x", child }, providers: {} }));
		const lines: string[] = [];
		expect(await installProviders(["codex"], { ...env, log: (line) => lines.push(line) })).toBe(0);
		await orphan.exited;
		expect(orphan.signalCode).toBe("SIGKILL");
		expect(isSameProcess(child)).toBe(false);
		expect(lines[0]).toContain(`stopping install step pid ${orphan.pid}`);
		expect(readProviderState(dir).installer).toBeUndefined();
	});

	test("the running step is recorded while it runs, then cleared", async () => {
		env.run = async (argv, _env, onSpawn) => {
			onSpawn({ pid: 4243, startTicks: "7", processGroup: true });
			expect(readProviderState(dir).installer?.child).toEqual({ pid: 4243, startTicks: "7", processGroup: true });
			onPath.add("codex");
			ran.push(argv);
			return 0;
		};
		expect(await installProviders(["codex"], env)).toBe(0);
		expect(ran).toHaveLength(1);
		expect(readProviderState(dir).installer).toBeUndefined();
	});

	test("low disk fails that provider before anything runs; the next one still installs", async () => {
		const codex = requiredBytes(provider("codex"));
		expect(codex).toBe((437 * 2 + 256) * 1024 * 1024);
		env.freeBytes = () => codex - 1;
		expect(await installProviders(["claude", "codex"], { ...env, backoffMs: [] })).toBe(1);
		expect(ran).toEqual([["install-claude-code"]]);
		expect(readProviderState(dir).providers.codex?.error).toMatch(/^low disk: needs about 1130 MiB free in .*, 1129 MiB free$/);
	});

	test("a CLI that appears during the round (T3's /welcome, a terminal) is not installed over", async () => {
		// Catalog order: codex installs first; claude shows up while it runs.
		env.run = async (argv) => {
			ran.push(argv);
			onPath.add("codex");
			onPath.add("claude");
			return 0;
		};
		expect(await installProviders(["claude", "codex"], env)).toBe(0);
		expect(ran).toEqual([["npm", "install", "--global", "--no-fund", "--no-audit", "@openai/codex"]]);
		expect(readProviderState(dir).providers.claude?.state).toBe("ready");
	});

	test("root reads and writes the app's state, whatever its HOME", () => {
		expect(stateDir({ HOME: "/root" }, 0)).toBe("/data/.local/state/t3code");
		expect(stateDir({ HOME: "/tmp/home" }, 1000)).toBe("/tmp/home/.local/state/t3code");
		expect(stateDir({}, 1000)).toBe("/data/.local/state/t3code");
	});

	test("status: selection, T3-managed providers, and CLIs found on PATH", () => {
		onPath.add("claude");
		onPath.add("muse");
		const status = buildProviderStatus("claude codex cursor", env.which, dir);
		const states = Object.fromEntries(status.providers.map((p) => [p.token, p.state]));
		expect(states).toEqual({
			codex: "pending",
			claude: "ready",
			cursor: "t3-managed",
			grok: "not-selected",
			opencode: "not-selected",
			antigravity: "not-selected",
			pi: "not-selected",
			muse: "not-selected",
		});
		expect(status.providers.find((p) => p.token === "muse")?.path).toBe("/data/.local/bin/muse");
	});
});
