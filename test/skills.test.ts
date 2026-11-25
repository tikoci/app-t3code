/**
 * T3APP_SKILLS (#46 P1): selection, the clash rule, ownership and refresh,
 * with the `skills` library replaced by a fake backend that writes the same
 * layout (a real folder in the shared directory, a relative link in
 * Claude's). No network: the docker replacement test covers a real fetch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import YAML from "js-yaml";
import { kernelFlock, LOCK_EX, LOCK_NB } from "../lib/runtime.ts";
import {
	buildSkillsStatus,
	DEFAULT_SKILLS,
	formatSkillsStatus,
	groupTokens,
	parseSkills,
	parseSkillToken,
	readSkillsState,
	type SkillDirs,
	type SkillsBackend,
	type SyncEnv,
	skillDirs,
	skillsSummary,
	syncSkills,
	USAGE,
} from "../lib/skills.ts";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("T3APP_SKILLS selection", () => {
	test("the skills CLI's GitHub forms: owner/repo, @skill, #ref, both orders, and @version as a ref", () => {
		expect(parseSkillToken("tikoci/routeros-skills")).toMatchObject({ repo: "tikoci/routeros-skills", ref: null, skill: null, source: "tikoci/routeros-skills" });
		expect(parseSkillToken("wiresage/routeros-skills@routeros-bgp")).toMatchObject({ skill: "routeros-bgp", ref: null, source: "wiresage/routeros-skills" });
		expect(parseSkillToken("o/r#v1.2")).toMatchObject({ ref: "v1.2", skill: null, source: "o/r#v1.2" });
		expect(parseSkillToken("o/r#main@one")).toMatchObject({ ref: "main", skill: "one", source: "o/r#main" });
		expect(parseSkillToken("o/r@one#feature/x")).toMatchObject({ ref: "feature/x", skill: "one", source: "o/r#feature/x" });
		// As the CLI reads it: @<version or commit> pins a ref, it is not a skill.
		expect(parseSkillToken("o/r@v1.2.0")).toMatchObject({ ref: "v1.2.0", skill: null });
		expect(parseSkillToken("o/r@09eda23")).toMatchObject({ ref: "09eda23", skill: null });
	});

	test("anything else is a warning, never an error: URLs, paths, subpaths, bad refs", () => {
		for (const token of ["https://github.com/o/r", "./local", "/abs", "o/r/sub", "o", "o/r@a#b@c", "o/r#a..b", "o/..", "o/r.git", "o/r@bad name"]) {
			expect({ token, parsed: typeof parseSkillToken(token) }).toEqual({ token, parsed: "string" });
		}
		const selection = parseSkills("tikoci/routeros-skills https://example.com/x");
		expect(selection.tokens.map((t) => t.token)).toEqual(["tikoci/routeros-skills"]);
		expect(selection.warnings).toHaveLength(1);
		expect(selection.warnings[0]).toContain("T3APP_SKILLS:");
	});

	test("unset and empty select the default; none installs nothing; order is kept, duplicates dropped", () => {
		for (const raw of [undefined, null, "", "  "]) expect(parseSkills(raw)).toMatchObject({ defaulted: true, tokens: [{ token: DEFAULT_SKILLS }], warnings: [] });
		expect(DEFAULT_SKILLS).toBe("tikoci/routeros-skills");
		expect(parseSkills("none").tokens).toEqual([]);
		expect(parseSkills("NONE a/b").tokens.map((t) => t.token)).toEqual(["a/b"]);
		expect(parseSkills("none a/b").warnings[0]).toContain('"none" combined');
		expect(parseSkills(" b/x a/y,b/x ").tokens.map((t) => t.token)).toEqual(["b/x", "a/y"]);
	});

	test("tokens from one repository and ref resolve once", () => {
		const groups = groupTokens(parseSkills("tikoci/routeros-skills wiresage/routeros-skills@routeros-bgp Wiresage/routeros-skills@routeros-ospf wiresage/routeros-skills#v1@routeros-bgp").tokens);
		expect(groups.map((g) => [g.source, g.tokens.length])).toEqual([
			["tikoci/routeros-skills", 1],
			["wiresage/routeros-skills", 2],
			["wiresage/routeros-skills#v1", 1],
		]);
	});

	test("the image ENV, both YAML files and the README ship the same default", () => {
		expect(/^ENV T3APP_SKILLS="([^"]*)"$/m.exec(read("Dockerfile"))?.[1]).toBe(DEFAULT_SKILLS);
		const app = YAML.load(read("app/t3code.tikapp.yaml")) as { services: { t3code: { environment: Record<string, string> } } };
		expect(app.services.t3code.environment["T3APP_SKILLS"]).toBe(DEFAULT_SKILLS);
		const store = (YAML.load(read("app/t3code.tikappstore.yaml")) as { name: string; services: { t3code: { environment: Record<string, string> } } }[]).find((d) => d.name === "t3code");
		expect(store?.services.t3code.environment["T3APP_SKILLS"]).toBe(DEFAULT_SKILLS);
		expect(read("README.md")).toContain(`| \`T3APP_SKILLS\` | \`${DEFAULT_SKILLS}\``);
	});

	test("the README's pick-a-few example parses to the documented tokens", () => {
		const example = /T3APP_SKILLS="(tikoci\/routeros-skills wiresage[^"]+)"/.exec(read("README.md"))?.[1];
		expect(example).toBeDefined();
		const selection = parseSkills(example);
		expect(selection.warnings).toEqual([]);
		expect(selection.tokens.map((t) => t.skill)).toEqual([null, "routeros-bgp", "routeros-ospf"]);
	});
});

describe("the library and the image", () => {
	test("skills is lib/'s one runtime dependency, pinned exactly, installed frozen, never auto-installed", () => {
		const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
		expect(pkg.dependencies).toEqual({ skills: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
		expect(read("bun.lock")).toContain(`"skills": ["skills@${pkg.dependencies["skills"]}"`);
		const dockerfile = read("Dockerfile");
		expect(dockerfile).toContain("COPY package.json bun.lock /tmp/t3app-deps/");
		expect(dockerfile).toContain("bun install --cwd /tmp/t3app-deps --production --frozen-lockfile --ignore-scripts");
		expect(dockerfile).toContain("mv /tmp/t3app-deps/node_modules /usr/local/lib/t3app/node_modules");
		expect(read("bin/t3app")).toContain("exec bun --no-install /usr/local/lib/t3app/t3app.ts");
	});

	test("telemetry is off on every call", () => {
		const source = read("lib/skills.ts");
		expect(source).toContain('process.env["DO_NOT_TRACK"] = "1"');
		expect(source.match(/telemetry: false/g)?.length).toBeGreaterThanOrEqual(3);
	});

	test("skillDirs matches where the library writes for claude-code and codex", () => {
		for (const claudeDir of [undefined, "/custom/claude"]) {
			const home = "/home/probe";
			const proc = Bun.spawnSync(
				[process.execPath, "-e", 'const { getSupportedAgents } = await import("skills"); console.log(JSON.stringify(Object.fromEntries(getSupportedAgents().map((a) => [a.id, a.globalSkillsDir]))))'],
				{ cwd: ROOT, env: { PATH: process.env["PATH"] ?? "", HOME: home, DO_NOT_TRACK: "1", ...(claudeDir ? { CLAUDE_CONFIG_DIR: claudeDir } : {}) } },
			);
			expect(proc.exitCode).toBe(0);
			const dirs = JSON.parse(proc.stdout.toString()) as Record<string, string>;
			const ours = skillDirs({ HOME: home, ...(claudeDir ? { CLAUDE_CONFIG_DIR: claudeDir } : {}) }, home);
			expect(ours).toEqual({ shared: dirs["codex"] as string, claude: dirs["claude-code"] as string });
		}
	});

	test("help names every command and the selection forms", () => {
		for (const word of ["status", "install", "update", "owner/repo@skill", "owner/repo#ref", "none", DEFAULT_SKILLS]) expect(USAGE).toContain(word);
		expect(read("lib/t3app.ts")).toContain('if (command === "skills") return skillsMain(rest);');
		expect(read("docker-entrypoint.sh")).toContain("background skills /usr/local/bin/t3app skills update --keep-trying");
	});
});

// --- the fake backend ---------------------------------------------------------

interface FakeSource {
	commit: string;
	skills: Record<string, string>;
}

/** Writes what skills 1.9.0 writes: the folder in shared, a relative link in claude. */
class FakeLibrary {
	sources = new Map<string, FakeSource>();
	offline = false;
	/** Sources that fail to resolve, as one unreachable or rate-limited repository would. */
	failing = new Set<string>();
	/** Called at the start of each install call, before anything is written. */
	onInstall: (names: readonly string[]) => void = () => {};
	/** Names whose Claude link the next installs fail to write (the shared copy is written first, as the library does). */
	failClaude = new Set<string>();
	/** Names Claude gets a copy of instead of a link (the library's fallback when linking fails). */
	copyClaude = new Set<string>();
	resolved: string[] = [];
	installs: string[][] = [];
	constructor(private dirs: SkillDirs) {}

	backend = async (): Promise<SkillsBackend> => ({
		resolve: async (source) => {
			this.resolved.push(source);
			if (this.offline || this.failing.has(source)) throw Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), { code: "SKILLS_SOURCE_FETCH_FAILED" });
			const found = this.sources.get(source);
			if (!found) throw Object.assign(new Error(`Repository not found: ${source}`), { code: "SKILLS_GIT_CLONE_FAILED" });
			const snapshot = { commit: found.commit, skills: { ...found.skills } };
			return {
				commit: snapshot.commit,
				skills: Object.keys(snapshot.skills),
				install: async (names) => {
					this.onInstall(names);
					this.installs.push([...names]);
					const failed: { skill: string; code: string; message: string }[] = [];
					for (const name of names) {
						const shared = join(this.dirs.shared, name);
						rmSync(shared, { recursive: true, force: true });
						mkdirSync(shared, { recursive: true });
						writeFileSync(join(shared, "SKILL.md"), snapshot.skills[name] as string);
						const link = join(this.dirs.claude, name);
						if (this.failClaude.has(name)) {
							failed.push({ skill: name, code: "SKILLS_INSTALL_FAILED", message: "EACCES: permission denied" });
							continue;
						}
						rmSync(link, { recursive: true, force: true });
						mkdirSync(dirname(link), { recursive: true });
						if (this.copyClaude.has(name)) {
							mkdirSync(link);
							writeFileSync(join(link, "SKILL.md"), snapshot.skills[name] as string);
						} else symlinkSync(relative(realpathSync(dirname(link)), shared), link); // as skills 1.9.0: from the physical directory
					}
					return { installed: names.filter((n) => !failed.some((f) => f.skill === n)), failed };
				},
				dispose: async () => {},
			};
		},
	});
}

describe("sync", () => {
	let home: string;
	let dirs: SkillDirs;
	let lib: FakeLibrary;
	let env: SyncEnv;
	let logs: string[];
	let slept: number[];
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "skills-"));
		dirs = skillDirs({ HOME: home }, home);
		lib = new FakeLibrary(dirs);
		lib.sources.set("tikoci/routeros-skills", { commit: "a".repeat(40), skills: { "routeros-firewall": "tikoci fw v1", "routeros-mndp": "tikoci mndp v1" } });
		lib.sources.set("wiresage/routeros-skills", { commit: "b".repeat(40), skills: { "routeros-firewall": "wiresage fw", "routeros-bgp": "wiresage bgp", "routeros-ospf": "wiresage ospf" } });
		logs = [];
		slept = [];
		env = { dir: join(home, ".local/state/t3code"), dirs, backend: lib.backend, backoffMs: [15_000, 60_000], sleep: async (ms) => void slept.push(ms), log: (line) => logs.push(line) };
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	const sync = (raw: string, mode: "install" | "update" = "update", e: SyncEnv = env) => syncSkills(parseSkills(raw), mode, e);
	const status = (raw: string) => buildSkillsStatus(raw, env.dir, dirs);
	const skillState = (raw: string) => Object.fromEntries(status(raw).skills.map((s) => [s.name, s.state]));
	const content = (name: string) => readFileSync(join(dirs.claude, name, "SKILL.md"), "utf8");

	test("a fresh home: every skill installed as a folder plus Claude's link, and recorded as ours", async () => {
		expect(await sync("tikoci/routeros-skills")).toBe(0);
		expect(lstatSync(join(dirs.shared, "routeros-mndp")).isDirectory()).toBe(true);
		expect(readlinkSync(join(dirs.claude, "routeros-mndp"))).toBe(relative(dirs.claude, join(dirs.shared, "routeros-mndp")));
		expect(content("routeros-mndp")).toBe("tikoci mndp v1");
		const owned = readSkillsState(env.dir).owned;
		expect(Object.keys(owned).sort()).toEqual(["routeros-firewall", "routeros-mndp"]);
		expect(owned["routeros-mndp"]).toMatchObject({ token: "tikoci/routeros-skills", source: "tikoci/routeros-skills", commit: "a".repeat(40), hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
		expect(skillState("tikoci/routeros-skills")).toEqual({ "routeros-firewall": "installed", "routeros-mndp": "installed" });
		const s = status("tikoci/routeros-skills");
		expect(s.tokens).toEqual([{ token: "tikoci/routeros-skills", source: "tikoci/routeros-skills", state: "resolved", commit: "a".repeat(40), skills: 2 }]);
		expect(skillsSummary(s)).toBe("tikoci/routeros-skills=resolved (2 installed)");
	});

	test("the earlier token wins a clash, decided before anything is written", async () => {
		const raw = "tikoci/routeros-skills wiresage/routeros-skills@routeros-bgp wiresage/routeros-skills@routeros-firewall";
		expect(await sync(raw)).toBe(0);
		// One resolve per source; wiresage installs only bgp: its firewall is never written.
		expect(lib.resolved).toEqual(["tikoci/routeros-skills", "wiresage/routeros-skills"]);
		expect(lib.installs).toEqual([["routeros-firewall", "routeros-mndp"], ["routeros-bgp"]]);
		expect(content("routeros-firewall")).toBe("tikoci fw v1");
		const s = status(raw);
		expect(s.clashes).toEqual([{ name: "routeros-firewall", token: "wiresage/routeros-skills@routeros-firewall", winner: "tikoci/routeros-skills" }]);
		expect(formatSkillsStatus(s)).toContain("(clash: tikoci/routeros-skills is earlier)");
		// Reversed, wiresage's copy wins, and since the folder is ours it is replaced.
		expect(await sync("wiresage/routeros-skills tikoci/routeros-skills")).toBe(0);
		expect(content("routeros-firewall")).toBe("wiresage fw");
		expect(readSkillsState(env.dir).owned["routeros-firewall"]?.source).toBe("wiresage/routeros-skills");
	});

	test("a skill folder or Claude entry we did not write is never written over", async () => {
		mkdirSync(join(dirs.shared, "routeros-mndp"), { recursive: true });
		writeFileSync(join(dirs.shared, "routeros-mndp", "SKILL.md"), "the user's own");
		mkdirSync(join(dirs.claude, "routeros-firewall"), { recursive: true });
		writeFileSync(join(dirs.claude, "routeros-firewall", "SKILL.md"), "claude-only user skill");
		expect(await sync("tikoci/routeros-skills")).toBe(0);
		expect(lib.installs).toEqual([]);
		expect(readFileSync(join(dirs.shared, "routeros-mndp", "SKILL.md"), "utf8")).toBe("the user's own");
		expect(content("routeros-firewall")).toBe("claude-only user skill");
		expect(readSkillsState(env.dir).owned).toEqual({});
		const s = status("tikoci/routeros-skills");
		expect(s.skills.map((k) => [k.name, k.state, k.detail?.slice(0, 8)])).toEqual([
			["routeros-firewall", "skipped", "not ours"],
			["routeros-mndp", "skipped", "not ours"],
		]);
	});

	test("a user-edited skill is reported at once and left alone across a refresh that moved", async () => {
		await sync("tikoci/routeros-skills");
		writeFileSync(join(dirs.shared, "routeros-mndp", "SKILL.md"), "my edits");
		expect(skillState("tikoci/routeros-skills")["routeros-mndp"]).toBe("modified");
		lib.sources.set("tikoci/routeros-skills", { commit: "c".repeat(40), skills: { "routeros-firewall": "tikoci fw v2", "routeros-mndp": "tikoci mndp v2" } });
		expect(await sync("tikoci/routeros-skills")).toBe(0);
		expect(content("routeros-mndp")).toBe("my edits");
		expect(content("routeros-firewall")).toBe("tikoci fw v2");
		expect(skillState("tikoci/routeros-skills")).toEqual({ "routeros-firewall": "installed", "routeros-mndp": "modified" });
		// Deleting the edited folder hands it back: the next run installs it again.
		rmSync(join(dirs.shared, "routeros-mndp"), { recursive: true });
		expect(skillState("tikoci/routeros-skills")["routeros-mndp"]).toBe("missing");
		await sync("tikoci/routeros-skills", "install");
		expect(content("routeros-mndp")).toBe("tikoci mndp v2");
		expect(skillState("tikoci/routeros-skills")["routeros-mndp"]).toBe("installed");
	});

	test("a replaced Claude link counts as a user change too", async () => {
		await sync("tikoci/routeros-skills");
		rmSync(join(dirs.claude, "routeros-mndp"));
		mkdirSync(join(dirs.claude, "routeros-mndp"));
		writeFileSync(join(dirs.claude, "routeros-mndp", "SKILL.md"), "claude-specific copy");
		expect(skillState("tikoci/routeros-skills")["routeros-mndp"]).toBe("modified");
		await sync("tikoci/routeros-skills");
		expect(content("routeros-mndp")).toBe("claude-specific copy");
	});

	test("install keeps a floating skill at its commit; update moves it; a changed #ref installs on either", async () => {
		await sync("tikoci/routeros-skills", "install");
		lib.sources.set("tikoci/routeros-skills", { commit: "c".repeat(40), skills: { "routeros-firewall": "tikoci fw v2", "routeros-mndp": "tikoci mndp v2" } });
		lib.installs = [];
		await sync("tikoci/routeros-skills", "install");
		expect(lib.installs).toEqual([]);
		expect(content("routeros-mndp")).toBe("tikoci mndp v1");
		await sync("tikoci/routeros-skills", "update");
		expect(content("routeros-mndp")).toBe("tikoci mndp v2");
		lib.sources.set("tikoci/routeros-skills#v1", { commit: "d".repeat(40), skills: { "routeros-firewall": "fw at v1", "routeros-mndp": "mndp at v1" } });
		await sync("tikoci/routeros-skills#v1@routeros-mndp", "install");
		expect(content("routeros-mndp")).toBe("mndp at v1");
		expect(readSkillsState(env.dir).owned["routeros-mndp"]).toMatchObject({ source: "tikoci/routeros-skills#v1", commit: "d".repeat(40) });
	});

	test("deselecting deletes nothing; re-enabling keeps what is there", async () => {
		await sync("tikoci/routeros-skills");
		expect(await sync("none")).toBe(0);
		expect(content("routeros-mndp")).toBe("tikoci mndp v1");
		expect(skillState("none")).toEqual({ "routeros-firewall": "kept", "routeros-mndp": "kept" });
		expect(skillsSummary(status("none"))).toBe("none");
		lib.installs = [];
		expect(await sync("tikoci/routeros-skills")).toBe(0);
		expect(lib.installs).toEqual([]);
		expect(skillState("tikoci/routeros-skills")).toEqual({ "routeros-firewall": "installed", "routeros-mndp": "installed" });
	});

	test("offline: nothing changes, installed skills stay, and the run fails so it is retried", async () => {
		await sync("tikoci/routeros-skills");
		lib.offline = true;
		expect(await sync("tikoci/routeros-skills", "update", { ...env, backoffMs: [] })).toBe(1);
		expect(content("routeros-mndp")).toBe("tikoci mndp v1");
		const s = status("tikoci/routeros-skills");
		expect(s.tokens[0]).toMatchObject({ state: "failed", code: "SKILLS_SOURCE_FETCH_FAILED", error: "getaddrinfo ENOTFOUND github.com" });
		expect(s.skills.map((k) => k.state)).toEqual(["installed", "installed"]);
		expect(logs.at(-1)).toContain("giving up for now");
	});

	test("--keep-trying retries a source that could not be fetched, releasing the lock in between", async () => {
		lib.offline = true;
		const e = { ...env, sleep: async (ms: number) => {
			slept.push(ms);
			// The lock is free while waiting: another run could take it.
			const fd = openSync(join(env.dir, "skills.lock"), "a+");
			expect(kernelFlock(fd, LOCK_EX | LOCK_NB)).toBe(true);
			closeSync(fd);
			expect(readSkillsState(env.dir).installer?.waitingUntil).toBeString();
			lib.offline = false;
		} };
		expect(await sync("tikoci/routeros-skills", "update", e)).toBe(0);
		expect(slept).toEqual([15_000]);
		expect(readSkillsState(env.dir).installer).toBeUndefined();
	});

	test("a skill the repository lacks fails without retrying; a repository that does not exist is retried", async () => {
		expect(await sync("tikoci/routeros-skills@no-such-skill")).toBe(1);
		expect(slept).toEqual([]);
		expect(status("tikoci/routeros-skills@no-such-skill").tokens[0]).toMatchObject({ state: "failed", code: "SKILLS_NO_MATCHING_SKILLS" });
		expect(await sync("tikoci/no-such-repo")).toBe(1);
		expect(slept).toEqual([15_000, 60_000]);
	});

	test("a repository named in another case is the same source: one resolve, one install, no clash", async () => {
		lib.sources.set("Wiresage/routeros-skills", lib.sources.get("wiresage/routeros-skills") as FakeSource);
		await sync("Wiresage/routeros-skills@routeros-bgp wiresage/routeros-skills@routeros-ospf");
		expect(lib.resolved).toEqual(["Wiresage/routeros-skills"]);
		expect(lib.installs).toEqual([["routeros-bgp", "routeros-ospf"]]);
		expect(status("Wiresage/routeros-skills@routeros-bgp wiresage/routeros-skills@routeros-ospf").clashes).toEqual([]);
		lib.installs = [];
		await sync("wiresage/routeros-skills@routeros-bgp wiresage/routeros-skills@routeros-ospf");
		expect(lib.installs).toEqual([]);
	});

	test("a name that is not its own folder name is skipped, not written elsewhere", async () => {
		lib.sources.set("o/r", { commit: "e".repeat(40), skills: { "Bad Name": "x", good: "y" } });
		await sync("o/r");
		expect(lib.installs).toEqual([["good"]]);
		expect(skillState("o/r")).toEqual({ "Bad Name": "skipped", good: "installed" });
	});

	test("a waiting --keep-trying run stops when a run with another selection finished meanwhile", async () => {
		lib.offline = true;
		const e = { ...env, sleep: async (ms: number) => {
			slept.push(ms);
			await Bun.sleep(2); // the terminal's pass starts after this run did
			// Meanwhile, from a terminal with its own T3APP_SKILLS, online.
			lib.offline = false;
			expect(await sync("wiresage/routeros-skills@routeros-bgp", "install")).toBe(0);
		} };
		expect(await sync("tikoci/routeros-skills", "update", e)).toBe(0);
		expect(slept).toEqual([15_000]);
		// The older selection was never applied, and the newer run's record stands.
		expect(lib.installs).toEqual([["routeros-bgp"]]);
		expect(existsSync(join(dirs.shared, "routeros-mndp"))).toBe(false);
		const state = readSkillsState(env.dir);
		expect(state.last?.selection).toBe("wiresage/routeros-skills@routeros-bgp");
		expect(state.installer).toBeUndefined();
		expect(logs.at(-1)).toContain("stopping: a run at");
	});

	test("a pass that started before this run (the lock holder at its start) never stops it", async () => {
		// An older pass with another selection is the last one recorded, and holds the lock as this run starts.
		mkdirSync(env.dir, { recursive: true });
		writeFileSync(join(env.dir, "skills.json"), JSON.stringify({ owned: {}, last: { id: "older", at: "2026-11-24T00:00:00.000Z", mode: "update", selection: "wiresage/routeros-skills@routeros-bgp", tokens: {}, results: {}, clashes: [] } }));
		const fd = openSync(join(env.dir, "skills.lock"), "a+");
		expect(kernelFlock(fd, LOCK_EX | LOCK_NB)).toBe(true);
		// --keep-trying (a longer back-off than an interactive run's): a busy lock waits a round.
		const e = { ...env, backoffMs: [15_000, 60_000, 300_000], sleep: async (ms: number) => {
			slept.push(ms);
			closeSync(fd); // the older pass ends without writing a newer record
		} };
		expect(await sync("tikoci/routeros-skills", "update", e)).toBe(0);
		expect(slept).toEqual([15_000]);
		expect(lib.installs).toEqual([["routeros-firewall", "routeros-mndp"]]);
		expect(readSkillsState(env.dir).last?.selection).toBe("tikoci/routeros-skills");
	});

	test("a folder that appears while an earlier source installs is not written over", async () => {
		lib.onInstall = (names) => {
			if (names.includes("routeros-mndp")) {
				mkdirSync(join(dirs.shared, "routeros-bgp"), { recursive: true });
				writeFileSync(join(dirs.shared, "routeros-bgp", "SKILL.md"), "made by the user meanwhile");
			}
		};
		await sync("tikoci/routeros-skills wiresage/routeros-skills@routeros-bgp");
		expect(lib.installs).toEqual([["routeros-firewall", "routeros-mndp"]]);
		expect(readFileSync(join(dirs.shared, "routeros-bgp", "SKILL.md"), "utf8")).toBe("made by the user meanwhile");
		expect(readSkillsState(env.dir).owned["routeros-bgp"]).toBeUndefined();
		expect(status("tikoci/routeros-skills wiresage/routeros-skills@routeros-bgp").skills.find((k) => k.name === "routeros-bgp")).toMatchObject({ state: "skipped", detail: expect.stringContaining("appeared during this run") });
	});

	test("Claude's skills directory may itself be a link (dotfiles): the library's links still count as ours", async () => {
		const real = join(home, "config", "dotfiles", "claude-skills"); // deeper than .claude/skills, so the relative target differs
		mkdirSync(real, { recursive: true });
		mkdirSync(dirname(dirs.claude), { recursive: true });
		symlinkSync(real, dirs.claude);
		await sync("tikoci/routeros-skills");
		expect(content("routeros-mndp")).toBe("tikoci mndp v1");
		expect(skillState("tikoci/routeros-skills")).toEqual({ "routeros-firewall": "installed", "routeros-mndp": "installed" });
		lib.installs = [];
		await sync("tikoci/routeros-skills");
		expect(lib.installs).toEqual([]);
	});

	test("a missing Claude link is put back without moving a pinned skill to a newer commit", async () => {
		lib.sources.set("tikoci/routeros-skills#stable", { commit: "d".repeat(40), skills: { "routeros-mndp": "mndp stable 1" } });
		await sync("tikoci/routeros-skills#stable");
		lib.sources.set("tikoci/routeros-skills#stable", { commit: "e".repeat(40), skills: { "routeros-mndp": "mndp stable 2" } });
		rmSync(join(dirs.claude, "routeros-mndp"));
		lib.installs = [];
		expect(await sync("tikoci/routeros-skills#stable", "update")).toBe(0);
		expect(lib.installs).toEqual([]);
		expect(content("routeros-mndp")).toBe("mndp stable 1");
		expect(skillState("tikoci/routeros-skills#stable")["routeros-mndp"]).toBe("installed");
		expect(readSkillsState(env.dir).owned["routeros-mndp"]?.commit).toBe("d".repeat(40));
	});

	test("a floating source that reports no commit is refreshed on update, not kept as unchanged", async () => {
		lib.sources.set("o/r", { commit: null as unknown as string, skills: { one: "one v1" } });
		await sync("o/r");
		lib.sources.set("o/r", { commit: null as unknown as string, skills: { one: "one v2" } });
		lib.installs = [];
		await sync("o/r", "install");
		expect(lib.installs).toEqual([]);
		await sync("o/r", "update");
		expect(lib.installs).toEqual([["one"]]);
		expect(content("one")).toBe("one v2");
	});

	test("a waiting run keeps retrying when the run meanwhile had the same selection", async () => {
		lib.offline = true;
		let calls = 0;
		const e = { ...env, sleep: async (ms: number) => {
			slept.push(ms);
			// Same selection from a terminal, still offline: the background run must not give up because of it.
			if (++calls === 1) expect(await sync("tikoci/routeros-skills", "install", { ...env, backoffMs: [] })).toBe(1);
			else lib.offline = false;
		} };
		expect(await sync("tikoci/routeros-skills", "update", e)).toBe(0);
		expect(slept).toEqual([15_000, 60_000]);
		expect(content("routeros-mndp")).toBe("tikoci mndp v1");
	});

	test("an install that fails partway is ours and is installed again next time, not orphaned", async () => {
		lib.failClaude.add("routeros-mndp");
		expect(await sync("tikoci/routeros-skills", "install", { ...env, backoffMs: [] })).toBe(1);
		expect(readSkillsState(env.dir).owned["routeros-mndp"]).toMatchObject({ incomplete: true });
		expect(status("tikoci/routeros-skills").skills.find((k) => k.name === "routeros-mndp")).toMatchObject({ state: "failed", code: "SKILLS_INSTALL_FAILED" });
		lib.failClaude.clear();
		lib.installs = [];
		expect(await sync("tikoci/routeros-skills", "install")).toBe(0);
		expect(lib.installs).toEqual([["routeros-mndp"]]);
		expect(content("routeros-mndp")).toBe("tikoci mndp v1");
		expect(readSkillsState(env.dir).owned["routeros-mndp"]?.incomplete).toBeUndefined();
		expect(skillState("tikoci/routeros-skills")["routeros-mndp"]).toBe("installed");
	});

	test("an update that fails after rewriting the folder is not mistaken for a user edit", async () => {
		await sync("tikoci/routeros-skills");
		lib.sources.set("tikoci/routeros-skills", { commit: "c".repeat(40), skills: { "routeros-firewall": "tikoci fw v2", "routeros-mndp": "tikoci mndp v2" } });
		rmSync(join(dirs.claude, "routeros-mndp"));
		lib.failClaude.add("routeros-mndp");
		await sync("tikoci/routeros-skills", "update", { ...env, backoffMs: [] });
		expect(skillState("tikoci/routeros-skills")["routeros-mndp"]).not.toBe("modified");
		lib.failClaude.clear();
		await sync("tikoci/routeros-skills");
		expect(content("routeros-mndp")).toBe("tikoci mndp v2");
		expect(skillState("tikoci/routeros-skills")["routeros-mndp"]).toBe("installed");
	});

	test("Claude's fallback copy (when the library cannot link) counts as ours", async () => {
		lib.copyClaude.add("routeros-mndp");
		await sync("tikoci/routeros-skills");
		expect(lstatSync(join(dirs.claude, "routeros-mndp")).isDirectory()).toBe(true);
		expect(skillState("tikoci/routeros-skills")["routeros-mndp"]).toBe("installed");
		lib.installs = [];
		await sync("tikoci/routeros-skills");
		expect(lib.installs).toEqual([]);
	});

	test("one source failing to resolve holds every write: a later token never takes an earlier token's name", async () => {
		const raw = "tikoci/routeros-skills wiresage/routeros-skills";
		await sync(raw);
		expect(content("routeros-firewall")).toBe("tikoci fw v1");
		lib.failing.add("tikoci/routeros-skills");
		lib.installs = [];
		expect(await sync(raw, "update", { ...env, backoffMs: [] })).toBe(1);
		expect(lib.installs).toEqual([]);
		expect(content("routeros-firewall")).toBe("tikoci fw v1");
		const s = status(raw);
		expect(s.lastRun?.held).toContain("tikoci/routeros-skills could not be fetched");
		expect(s.tokens.map((t) => t.state)).toEqual(["failed", "resolved"]);
		expect(s.skills.find((k) => k.name === "routeros-firewall")).toMatchObject({ state: "installed", token: "tikoci/routeros-skills" });
		expect(formatSkillsStatus(s)).toContain("last run: nothing installed or updated");
		// A fresh home is held too, even for names no other token has.
		rmSync(home, { recursive: true, force: true });
		mkdirSync(home);
		expect(await sync("tikoci/routeros-skills wiresage/routeros-skills@routeros-bgp", "update", { ...env, backoffMs: [] })).toBe(1);
		expect(lib.installs).toEqual([]);
		expect(existsSync(join(dirs.shared, "routeros-bgp"))).toBe(false);
	});

	test("update never moves a pinned #ref: only a token without #ref follows its source", async () => {
		lib.sources.set("tikoci/routeros-skills#stable", { commit: "d".repeat(40), skills: { "routeros-mndp": "mndp stable 1" } });
		await sync("tikoci/routeros-skills#stable");
		lib.sources.set("tikoci/routeros-skills#stable", { commit: "e".repeat(40), skills: { "routeros-mndp": "mndp stable 2" } });
		lib.installs = [];
		await sync("tikoci/routeros-skills#stable", "update");
		expect(lib.installs).toEqual([]);
		expect(content("routeros-mndp")).toBe("mndp stable 1");
		expect(readSkillsState(env.dir).owned["routeros-mndp"]?.commit).toBe("d".repeat(40));
	});

	test("a failed update of Claude's fallback copy is repaired next time; an edit to that copy afterwards is still protected", async () => {
		lib.copyClaude.add("routeros-mndp");
		await sync("tikoci/routeros-skills");
		lib.sources.set("tikoci/routeros-skills", { commit: "c".repeat(40), skills: { "routeros-firewall": "tikoci fw v2", "routeros-mndp": "tikoci mndp v2" } });
		lib.failClaude.add("routeros-mndp");
		expect(await sync("tikoci/routeros-skills", "update", { ...env, backoffMs: [] })).toBe(1);
		// Shared has v2, Claude's untouched copy still v1: both are ours.
		expect(readFileSync(join(dirs.shared, "routeros-mndp", "SKILL.md"), "utf8")).toBe("tikoci mndp v2");
		expect(content("routeros-mndp")).toBe("tikoci mndp v1");
		expect(readSkillsState(env.dir).owned["routeros-mndp"]).toMatchObject({ incomplete: true, claudeHash: expect.any(String) });
		lib.failClaude.clear();
		expect(await sync("tikoci/routeros-skills")).toBe(0);
		expect(content("routeros-mndp")).toBe("tikoci mndp v2");
		expect(skillState("tikoci/routeros-skills")["routeros-mndp"]).toBe("installed");
		// Now the user edits Claude's copy: modified, and a refresh leaves it.
		writeFileSync(join(dirs.claude, "routeros-mndp", "SKILL.md"), "claude-side edit");
		expect(skillState("tikoci/routeros-skills")["routeros-mndp"]).toBe("modified");
		lib.sources.set("tikoci/routeros-skills", { commit: "f".repeat(40), skills: { "routeros-firewall": "tikoci fw v3", "routeros-mndp": "tikoci mndp v3" } });
		await sync("tikoci/routeros-skills");
		expect(content("routeros-mndp")).toBe("claude-side edit");
	});

	test("the names an install call will write are recorded before it writes", async () => {
		const seen: unknown[] = [];
		lib.onInstall = () => seen.push(readSkillsState(env.dir).pending?.skills);
		await sync("tikoci/routeros-skills");
		expect(seen).toEqual([{ "routeros-firewall": expect.objectContaining({ token: "tikoci/routeros-skills" }), "routeros-mndp": expect.objectContaining({ commit: "a".repeat(40) }) }]);
		expect(readSkillsState(env.dir).pending).toBeUndefined();
	});

	test("a run killed mid-install: its leftovers are ours and installed again; a user's folder is still not", async () => {
		// What a killed run leaves: pending names, files for one, nothing for another.
		mkdirSync(join(dirs.shared, "routeros-mndp"), { recursive: true });
		writeFileSync(join(dirs.shared, "routeros-mndp", "SKILL.md"), "half written");
		mkdirSync(join(dirs.shared, "routeros-firewall-user"), { recursive: true });
		mkdirSync(env.dir, { recursive: true });
		const pending = { runId: "x", at: "2026-11-24T00:00:00.000Z", skills: { "routeros-mndp": { token: "tikoci/routeros-skills", source: "tikoci/routeros-skills", commit: "a".repeat(40) }, "routeros-firewall": { token: "tikoci/routeros-skills", source: "tikoci/routeros-skills", commit: "a".repeat(40) } } };
		writeFileSync(join(env.dir, "skills.json"), JSON.stringify({ owned: {}, pending }));
		lib.sources.set("tikoci/routeros-skills", { commit: "a".repeat(40), skills: { "routeros-firewall": "tikoci fw v1", "routeros-mndp": "tikoci mndp v1", "routeros-firewall-user": "upstream" } });
		expect(await sync("tikoci/routeros-skills")).toBe(0);
		expect(lib.installs).toEqual([["routeros-firewall", "routeros-mndp"]]);
		expect(content("routeros-mndp")).toBe("tikoci mndp v1");
		expect(logs.some((l) => l.includes("an earlier run stopped while installing routeros-mndp"))).toBe(true);
		expect(skillState("tikoci/routeros-skills")).toEqual({ "routeros-firewall": "installed", "routeros-firewall-user": "skipped", "routeros-mndp": "installed" });
	});

	test("a missing Claude entry is reported as missing, and the next run puts it back", async () => {
		await sync("tikoci/routeros-skills");
		rmSync(join(dirs.claude, "routeros-mndp"));
		expect(status("tikoci/routeros-skills").skills.find((k) => k.name === "routeros-mndp")).toMatchObject({ state: "missing", detail: expect.stringContaining("Claude's entry") });
		await sync("tikoci/routeros-skills", "install");
		expect(content("routeros-mndp")).toBe("tikoci mndp v1");
	});

	test("another run holding the lock: an interactive run says so and exits 1", async () => {
		mkdirSync(env.dir, { recursive: true });
		const fd = openSync(join(env.dir, "skills.lock"), "a+");
		expect(kernelFlock(fd, LOCK_EX | LOCK_NB)).toBe(true);
		try {
			expect(await sync("tikoci/routeros-skills")).toBe(1);
			expect(logs.at(-1)).toContain("another skills run is in progress");
		} finally {
			closeSync(fd);
		}
	});

	test("custom provider homes: CLAUDE_CONFIG_DIR moves Claude's links, not the shared copy", async () => {
		const custom = skillDirs({ HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude-home") }, home);
		expect(custom).toEqual({ shared: dirs.shared, claude: join(home, "claude-home", "skills") });
		const customLib = new FakeLibrary(custom);
		customLib.sources = lib.sources;
		await syncSkills(parseSkills("tikoci/routeros-skills"), "update", { ...env, dirs: custom, backend: customLib.backend });
		expect(readFileSync(join(home, "claude-home/skills/routeros-mndp/SKILL.md"), "utf8")).toBe("tikoci mndp v1");
		expect(existsSync(join(dirs.claude, "routeros-mndp"))).toBe(false);
		expect(buildSkillsStatus("tikoci/routeros-skills", env.dir, custom).skills.map((s) => s.state)).toEqual(["installed", "installed"]);
	});

	test("status before any run, and after the selection changed", async () => {
		expect(formatSkillsStatus(status("tikoci/routeros-skills"))).toContain("no run yet");
		await sync("tikoci/routeros-skills");
		const changed = status("tikoci/routeros-skills wiresage/routeros-skills@routeros-bgp");
		expect(changed.tokens.map((t) => t.state)).toEqual(["pending", "pending"]);
		expect(formatSkillsStatus(changed)).toContain("the selection changed since the last run");
	});
});
