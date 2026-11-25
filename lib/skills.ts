// T3APP_SKILLS: user-level agent skills imported into the home at runtime
// with the `skills` npm library (vercel-labs/skills), issue #46 P1. One env
// key selects repositories (or single skills from them) in the `skills` CLI's
// own source syntax; the library fetches them and writes each skill where the
// providers look: the real copy in ~/.agents/skills/<name> (Codex, and the
// other agents that read the shared directory) and a symlink in Claude's
// skills directory (~/.claude/skills, or $CLAUDE_CONFIG_DIR/skills).
//
// What this file adds on top of the library:
// - Clashes are decided before anything is written: every token is resolved
//   first, each skill name goes to the earliest token that has it, and only
//   the winners are passed to the library (which would otherwise overwrite
//   silently). A skill directory this image did not write (the user's own,
//   another tool's) is never written over.
// - Ownership is our own record, skills.json in the state directory: per
//   installed skill, its token, source, commit and a hash of the installed
//   folder. A folder whose hash no longer matches was edited by the user and
//   is left alone ("modified"). The library's own lock is still written, so a
//   user's `npx skills list -g` sees these skills.
// - Refresh: at start (`update --keep-trying`, in the background) and on
//   `t3app skills update`, a floating token whose commit moved is installed
//   again; `install` only adds what is missing or whose source changed.
//   Deselecting never deletes.
//
// Never throw on operator input: a malformed token is a warning, and T3 must
// always start. Telemetry is off on every call (and DO_NOT_TRACK is set for
// the library). The image copies lib/ to /usr/local/lib/t3app/ with the
// library installed beside it (node_modules, frozen lockfile); lib/t3app.ts
// dispatches `t3app skills` here.
import { closeSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	appHome,
	helpRequest,
	INTERACTIVE_BACKOFF_MS,
	isSameProcess,
	KEEP_TRYING_BACKOFF_MS,
	kernelFlock,
	LOCK_EX,
	LOCK_NB,
	lockHolder,
	pidLabel,
	type ProcessId,
	processStartTicks,
	startOnce,
	stateDir,
} from "./runtime.ts";

export const SKILLS_ENV = "T3APP_SKILLS";
/** The shipped default: tikoci's RouterOS skills, all of them. */
export const DEFAULT_SKILLS = "tikoci/routeros-skills";
/** The `skills` agents written for, fixed: Codex writes the shared copy, Claude Code links to it. */
export const SKILL_AGENTS = ["claude-code", "codex"] as const;

// --- selection -------------------------------------------------------------

export interface SkillToken {
	/** As written in the selection. */
	token: string;
	/** `owner/repo`. */
	repo: string;
	/** A branch, tag or commit, from `#ref` (or the CLI's `@<version or sha>`). */
	ref: string | null;
	/** One skill, from `@skill`; null takes every skill in the repo. */
	skill: string | null;
	/** What is resolved: `owner/repo` or `owner/repo#ref`. Tokens that share it resolve once. */
	source: string;
}

export interface SkillSelection {
	variable: string;
	raw: string | null;
	defaulted: boolean;
	tokens: SkillToken[];
	warnings: string[];
}

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const REPO = "[A-Za-z0-9._-]{1,100}";
const NAME = "[A-Za-z0-9][A-Za-z0-9._-]{0,254}";
const REF = "[A-Za-z0-9._/+-]{1,255}";
// owner/repo, then @skill and #ref in either order, as the skills CLI reads them.
const TOKEN_RE = new RegExp(`^(${OWNER})/(${REPO})(?:@(${REF}))?(?:#(${REF}))?(?:@(${NAME}))?$`);
/** A skill name that is also its folder name (what the library's sanitizer leaves unchanged). */
const SKILL_NAME_RE = /^[a-z0-9_](?:[a-z0-9._-]{0,253}[a-z0-9_])?$/;
/** The CLI reads `owner/repo@<this>` as a ref, not a skill: a version or a commit. */
const VERSION_PIN_RE = /^v?\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$|^[0-9a-f]{7,40}$/;

/** One token, or why it is not one. */
export function parseSkillToken(token: string): SkillToken | string {
	const m = TOKEN_RE.exec(token);
	if (!m || m[2] === "." || m[2] === ".." || m[2]?.endsWith(".git")) return `"${token}" is not owner/repo, owner/repo@skill or owner/repo#ref`;
	const [, owner, repo, at, hashRef, fragmentSkill] = m as unknown as [string, string, string, string | undefined, string | undefined, string | undefined];
	if (at !== undefined && fragmentSkill !== undefined) return `"${token}" names a skill twice`;
	let ref = hashRef ?? null;
	let skill = fragmentSkill ?? null;
	if (at !== undefined) {
		if (!hashRef && VERSION_PIN_RE.test(at)) ref = at;
		else if (new RegExp(`^${NAME}$`).test(at)) skill = at;
		else return `"${token}": "${at}" is not a skill name`;
	}
	if (ref?.includes("..") || ref?.startsWith("/") || ref?.endsWith("/")) return `"${token}": "${ref}" is not a git ref`;
	const base = `${owner}/${repo}`;
	return { token, repo: base, ref, skill, source: ref ? `${base}#${ref}` : base };
}

/**
 * Parse T3APP_SKILLS: tokens separated by spaces (commas are read as spaces,
 * but RouterOS splits /app/set environment= values on commas, so the docs
 * say spaces). Unset or empty is DEFAULT_SKILLS; `none` installs nothing.
 * A malformed token is a warning and is skipped. Order matters: on a name
 * clash the earlier token wins.
 */
export function parseSkills(raw: string | undefined | null): SkillSelection {
	const defaulted = (raw ?? "").trim() === "";
	const selection: SkillSelection = { variable: SKILLS_ENV, raw: raw ?? null, defaulted, tokens: [], warnings: [] };
	const words = (defaulted ? DEFAULT_SKILLS : (raw as string)).split(/[\s,]+/).filter(Boolean);
	let sawNone = false;
	for (const word of words) {
		if (word.toLowerCase() === "none") {
			sawNone = true;
			continue;
		}
		const parsed = parseSkillToken(word);
		if (typeof parsed === "string") selection.warnings.push(`${SKILLS_ENV}: ${parsed}; ignored`);
		else if (!selection.tokens.some((t) => t.token === parsed.token)) selection.tokens.push(parsed);
	}
	if (sawNone && selection.tokens.length) selection.warnings.push(`${SKILLS_ENV}: "none" combined with other tokens; using the other tokens`);
	return selection;
}

/** What makes two sources the same: the repository case-insensitively (as GitHub reads it), the ref exactly. */
export function sourceKey(source: string): string {
	const hash = source.indexOf("#");
	return hash < 0 ? source.toLowerCase() : `${source.slice(0, hash).toLowerCase()}${source.slice(hash)}`;
}

/** A selection's tokens in order, for telling two selections apart (unset and the default are the same). */
export function selectionKey(selection: SkillSelection): string {
	return selection.tokens.map((t) => t.token).join(" ");
}

/** Tokens that share a source, in first-seen order. */
export function groupTokens(tokens: readonly SkillToken[]): { source: string; tokens: SkillToken[] }[] {
	const groups = new Map<string, { source: string; tokens: SkillToken[] }>();
	for (const token of tokens) {
		const key = sourceKey(token.source);
		const group = groups.get(key) ?? { source: token.source, tokens: [] };
		group.tokens.push(token);
		groups.set(key, group);
	}
	return [...groups.values()];
}

// --- where skills live --------------------------------------------------------

export interface SkillDirs {
	/** The real copies: ~/.agents/skills (the `skills` canonical global directory, Codex's). */
	shared: string;
	/** Claude Code's links: $CLAUDE_CONFIG_DIR/skills, else ~/.claude/skills. */
	claude: string;
}

/**
 * The directories the library writes for SKILL_AGENTS, computed the way
 * skills 1.9.0 computes them (a test compares against the library), so
 * status never has to load it.
 */
export function skillDirs(env: NodeJS.ProcessEnv = process.env, home = appHome(env)): SkillDirs {
	const claudeHome = env["CLAUDE_CONFIG_DIR"]?.trim() || join(home, ".claude");
	return { shared: join(home, ".agents", "skills"), claude: join(claudeHome, "skills") };
}

/** A stable hash of a skill folder: every path, its type, and file contents or link target. */
export function folderHash(dir: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	const walk = (rel: string) => {
		const entries = readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			const path = rel ? `${rel}/${entry.name}` : entry.name;
			const full = join(dir, path);
			if (entry.isSymbolicLink()) hasher.update(`L\0${path}\0${readlinkSync(full)}\0`);
			else if (entry.isDirectory()) {
				hasher.update(`D\0${path}\0`);
				walk(path);
			} else if (entry.isFile()) {
				hasher.update(`F\0${path}\0`);
				hasher.update(readFileSync(full));
				hasher.update("\0");
			} else hasher.update(`O\0${path}\0`);
		}
	};
	walk("");
	return hasher.digest("hex");
}

/**
 * What is on disk for one skill name. `shared`: a real directory, nothing, or
 * something else (a file, a link). `claude`: ours (the link to the shared
 * copy, or the library's fallback copy with the same content), nothing, or
 * something else.
 */
export interface DiskState {
	shared: "dir" | "absent" | "other";
	claude: "ours" | "absent" | "other";
	hash: string | null;
}

function lstatOrNull(path: string) {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
}

export function diskState(name: string, dirs: SkillDirs): DiskState {
	const sharedPath = join(dirs.shared, name);
	const shared = lstatOrNull(sharedPath);
	const claudePath = join(dirs.claude, name);
	const claude = lstatOrNull(claudePath);
	let claudeState: DiskState["claude"] = "absent";
	if (claude) {
		claudeState = "other";
		if (claude.isSymbolicLink()) {
			try {
				if (resolve(dirname(claudePath), readlinkSync(claudePath)) === resolve(sharedPath)) claudeState = "ours";
			} catch {
				// Unreadable: not ours.
			}
		}
	}
	const isDir = Boolean(shared?.isDirectory());
	let hash: string | null = null;
	if (isDir) {
		try {
			hash = folderHash(sharedPath);
		} catch {
			hash = null;
		}
	}
	// The library falls back to a copy when it cannot link: the same content is ours too.
	if (claudeState === "other" && claude?.isDirectory() && hash !== null) {
		try {
			if (folderHash(claudePath) === hash) claudeState = "ours";
		} catch {
			// Unreadable: not ours.
		}
	}
	return { shared: shared ? (isDir ? "dir" : "other") : "absent", claude: claudeState, hash };
}

// --- state ---------------------------------------------------------------------

/** A skill this image installed: the ownership record. */
export interface OwnedSkill {
	token: string;
	source: string;
	commit: string | null;
	/** folderHash of the shared copy right after we wrote it. */
	hash: string;
	installedAt: string;
	updatedAt: string;
	/** An install that failed partway: what it wrote is ours, and the next run installs it again. */
	incomplete?: boolean;
}

export type SkillResultState = "installed" | "skipped" | "modified" | "failed";

/** The last run's outcome for one name. */
export interface SkillResult {
	state: SkillResultState;
	token: string;
	source: string;
	commit: string | null;
	/** skipped: why (a clash, a folder that is not ours); failed: the error. */
	detail?: string;
	/** failed: the library's diagnostic code, when it gave one. */
	code?: string;
}

export interface TokenResult {
	state: "resolved" | "failed";
	source: string;
	commit: string | null;
	/** resolved: the skills this token selected. */
	skills?: string[];
	error?: string;
	code?: string;
}

export interface SkillsRun {
	/** Unique per pass, so a waiting run can tell whether another pass ran since its own. */
	id: string;
	at: string;
	mode: "install" | "update";
	selection: string | null;
	tokens: Record<string, TokenResult>;
	results: Record<string, SkillResult>;
	/** Names a later token also had, from another source: not installed from it. */
	clashes: { name: string; token: string; winner: string }[];
}

export interface InstallerRecord extends ProcessId {
	startedAt: string;
	waitingUntil?: string;
}

export interface SkillsState {
	installer?: InstallerRecord;
	owned: Record<string, OwnedSkill>;
	last?: SkillsRun;
}

export function readSkillsState(dir: string): SkillsState {
	try {
		const state = JSON.parse(readFileSync(join(dir, "skills.json"), "utf8")) as SkillsState;
		return { ...state, owned: state.owned ?? {} };
	} catch {
		return { owned: {} };
	}
}

/** Only the lock holder writes the state. */
function writeSkillsState(dir: string, state: SkillsState) {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "skills.json");
	writeFileSync(`${path}.${process.pid}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
	renameSync(`${path}.${process.pid}.tmp`, path);
}

// --- the plan ---------------------------------------------------------------------

/** One resolved source: its commit and skill names. */
export interface Resolved {
	commit: string | null;
	skills: readonly string[];
}

export type Action = "install" | "keep";

export interface PlannedSkill {
	name: string;
	token: SkillToken;
	commit: string | null;
	/** install: write it (new, missing, source changed or moved on update); keep: up to date. */
	action: Action | "skip" | "modified";
	detail?: string;
}

export interface Plan {
	skills: PlannedSkill[];
	/** Names a later token also had: not installed from it. */
	clashes: { name: string; token: SkillToken; winner: SkillToken }[];
	/** `owner/repo@skill` tokens whose skill is not in the repo. */
	missing: { name: string; token: SkillToken }[];
}

/**
 * Decide everything before anything is written. Each name goes to the
 * earliest token that has it (tokens of one source share their names);
 * later tokens with that name are clashes. Then, per winner: a name with no
 * record whose folder or Claude entry exists is not ours (skip); an owned one
 * whose folder no longer hashes to its record, or whose Claude entry is no
 * longer our link, is user-modified (left alone); an owned one that is
 * missing, came from another source, or (on update) moved, is installed.
 */
export function planSkills(
	tokens: readonly SkillToken[],
	resolved: ReadonlyMap<string, Resolved>,
	owned: Readonly<Record<string, OwnedSkill>>,
	disk: (name: string) => DiskState,
	mode: "install" | "update",
): Plan {
	const plan: Plan = { skills: [], clashes: [], missing: [] };
	const winners = new Map<string, SkillToken>();
	for (const token of tokens) {
		const source = resolved.get(token.source);
		if (!source) continue;
		let names = source.skills;
		if (token.skill !== null) {
			const wanted = token.skill;
			const found = source.skills.find((n) => n === wanted) ?? source.skills.find((n) => n.toLowerCase() === wanted.toLowerCase());
			if (!found) {
				plan.missing.push({ name: wanted, token });
				continue;
			}
			names = [found];
		}
		for (const name of names) {
			const winner = winners.get(name);
			if (!winner) winners.set(name, token);
			else if (sourceKey(winner.source) !== sourceKey(token.source) && !plan.clashes.some((c) => c.name === name && c.token.token === token.token)) plan.clashes.push({ name, token, winner });
		}
	}
	for (const [name, token] of winners) {
		const commit = resolved.get(token.source)?.commit ?? null;
		const entry = (action: PlannedSkill["action"], detail?: string): PlannedSkill => ({ name, token, commit, action, ...(detail ? { detail } : {}) });
		if (!SKILL_NAME_RE.test(name)) {
			// The library would write it under another folder name; keep to names that are their own folder.
			plan.skills.push(entry("skip", "not a plain skill name (lowercase letters, digits, dots, dashes, underscores)"));
			continue;
		}
		const record = owned[name];
		const on = disk(name);
		if (!record) {
			if (on.shared !== "absent") plan.skills.push(entry("skip", "not ours: a skill folder by that name exists in the shared directory"));
			else if (on.claude !== "absent") plan.skills.push(entry("skip", "not ours: Claude's skills directory has an entry by that name"));
			else plan.skills.push(entry("install"));
			continue;
		}
		if (on.shared === "other") plan.skills.push(entry("modified", "the shared entry is no longer a folder"));
		else if (on.claude === "other") plan.skills.push(entry("modified", "Claude's entry is no longer the link to the shared copy"));
		else if (on.shared === "dir" && on.hash !== record.hash) plan.skills.push(entry("modified", "edited since it was installed"));
		else if (on.shared === "absent" || on.claude === "absent") plan.skills.push(entry("install", "missing"));
		else if (record.incomplete) plan.skills.push(entry("install", "the last install failed partway"));
		else if (sourceKey(record.source) !== sourceKey(token.source)) plan.skills.push(entry("install", `source changed from ${record.source}`));
		else if (mode === "update" && commit && record.commit !== commit) plan.skills.push(entry("install", `moved from ${record.commit?.slice(0, 7) ?? "unknown"}`));
		else plan.skills.push(entry("keep"));
	}
	return plan;
}

// --- backend (the skills library, or a fake in tests) ---------------------------

export interface InstallOutcome {
	installed: string[];
	failed: { skill: string; code: string; message: string }[];
}

export interface ResolvedSource extends Resolved {
	install(names: readonly string[]): Promise<InstallOutcome>;
	dispose(): Promise<void>;
}

export interface SkillsBackend {
	resolve(source: string): Promise<ResolvedSource>;
}

/** Longest one resolve or install may take before it is abandoned. */
export const OPERATION_TIMEOUT_MS = 10 * 60_000;

/** An error's diagnostic code (SKILLS_*), if it has one. */
export function errorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
}

/** The library, loaded only when a run needs it; telemetry off before it loads. */
export async function libraryBackend(): Promise<SkillsBackend> {
	process.env["DO_NOT_TRACK"] = "1";
	process.env["DISABLE_TELEMETRY"] = "1";
	const lib = await import("skills");
	return {
		async resolve(source) {
			const handle = await lib.resolveSource(source, { signal: AbortSignal.timeout(OPERATION_TIMEOUT_MS), config: { telemetry: false } });
			return {
				commit: handle.source.commit ?? null,
				skills: handle.skills.map((s) => s.name),
				async install(names) {
					const result = await lib.installSkills(handle, {
						scope: "global",
						agents: [...SKILL_AGENTS],
						skills: [...names],
						mode: "symlink",
						lockfile: true,
						telemetry: false,
						config: { telemetry: false },
						signal: AbortSignal.timeout(OPERATION_TIMEOUT_MS),
					});
					const failed: InstallOutcome["failed"] = result.failed.map((f) => ({ skill: f.skill, code: f.code, message: f.message }));
					const installed = names.filter((name) => !failed.some((f) => f.skill === name) && SKILL_AGENTS.every((agent) => result.installed.some((i) => i.skill === name && i.agent === agent)));
					for (const name of names) {
						if (!installed.includes(name) && !failed.some((f) => f.skill === name)) failed.push({ skill: name, code: "NOT_INSTALLED", message: "the library installed it for no agent or only some" });
					}
					return { installed, failed };
				},
				dispose: () => handle.dispose(),
			};
		},
	};
}

// --- install ------------------------------------------------------------------------

export interface SyncEnv {
	dir: string;
	dirs: SkillDirs;
	backend: () => Promise<SkillsBackend>;
	backoffMs: readonly number[];
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
}

export function defaultSyncEnv(keepTrying: boolean): SyncEnv {
	return {
		dir: stateDir(),
		dirs: skillDirs(),
		backend: libraryBackend,
		backoffMs: keepTrying ? KEEP_TRYING_BACKOFF_MS : INTERACTIVE_BACKOFF_MS,
		sleep: (ms) => Bun.sleep(ms),
		log: (line) => console.log(`${new Date().toISOString()} t3app skills: ${line}`),
	};
}

function tryLock(dir: string): number | null {
	mkdirSync(dir, { recursive: true });
	// Never unlinked: a waiter must not lock an orphaned inode.
	const fd = openSync(join(dir, "skills.lock"), "a+");
	if (kernelFlock(fd, LOCK_EX | LOCK_NB)) {
		ftruncateSync(fd, 0);
		writeSync(fd, `${process.pid}\n`, 0);
		return fd;
	}
	closeSync(fd);
	return null;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

/** A failed resolve, with a hint when GitHub's anonymous limit is the cause. */
function describeFailure(error: unknown): { error: string; code?: string } {
	let text = message(error);
	if (/rate limit|\b403\b|\b429\b/i.test(text)) text += " (GitHub rate limit: set GH_TOKEN or GITHUB_TOKEN with /app/set environment=, or wait an hour)";
	const code = errorCode(error);
	return { error: text, ...(code ? { code } : {}) };
}

/**
 * One pass: resolve every source, plan, install the winners, record. Returns
 * the run; the caller holds the lock and writes the state.
 */
export async function syncOnce(selection: SkillSelection, mode: "install" | "update", state: SkillsState, env: SyncEnv): Promise<SkillsRun> {
	const run: SkillsRun = { id: crypto.randomUUID(), at: new Date().toISOString(), mode, selection: selection.raw, tokens: {}, results: {}, clashes: [] };
	if (selection.tokens.length === 0) return run;
	const groups = groupTokens(selection.tokens);
	const handles = new Map<string, ResolvedSource>();
	let backend: SkillsBackend;
	try {
		backend = await env.backend();
	} catch (error) {
		const failure = describeFailure(error);
		for (const token of selection.tokens) run.tokens[token.token] = { state: "failed", source: token.source, commit: null, error: `cannot load the skills library: ${failure.error}` };
		return run;
	}
	try {
		for (const group of groups) {
			try {
				env.log(`resolving ${group.source}`);
				const handle = await backend.resolve(group.source);
				handles.set(group.source, handle);
				for (const token of group.tokens) handles.set(token.source, handle);
			} catch (error) {
				const failure = describeFailure(error);
				env.log(`${group.source}: failed: ${failure.error}`);
				for (const token of group.tokens) run.tokens[token.token] = { state: "failed", source: token.source, commit: null, ...failure };
			}
		}
		const plan = planSkills(selection.tokens, handles, state.owned, (name) => diskState(name, env.dirs), mode);
		for (const token of selection.tokens) {
			const handle = handles.get(token.source);
			if (!handle) continue;
			run.tokens[token.token] = { state: "resolved", source: token.source, commit: handle.commit, skills: plan.skills.filter((s) => s.token === token).map((s) => s.name) };
		}
		for (const miss of plan.missing) {
			const result = run.tokens[miss.token.token];
			if (result) Object.assign(result, { state: "failed", error: `no skill "${miss.name}" in ${miss.token.source}`, code: NO_SUCH_SKILL });
		}
		const record = (p: PlannedSkill, state: SkillResultState, extra: Partial<SkillResult> = {}) => {
			run.results[p.name] = { state, token: p.token.token, source: p.token.source, commit: p.commit, ...(p.detail ? { detail: p.detail } : {}), ...extra };
		};
		for (const p of plan.skills) {
			const owned = state.owned[p.name];
			if (p.action === "keep" && owned) {
				owned.token = p.token.token;
				record(p, "installed", { commit: owned.commit });
			} else if (p.action === "skip") record(p, "skipped");
			else if (p.action === "modified") record(p, "modified", { commit: state.owned[p.name]?.commit ?? null });
		}
		// Install the winners, one call per source.
		for (const group of groups) {
			const handle = handles.get(group.source);
			const names = plan.skills.filter((p) => p.action === "install" && group.tokens.includes(p.token)).map((p) => p.name);
			if (!handle || names.length === 0) continue;
			env.log(`${group.source}: installing ${names.join(" ")}`);
			let outcome: InstallOutcome;
			try {
				outcome = await handle.install(names);
			} catch (error) {
				const failure = describeFailure(error);
				outcome = { installed: [], failed: names.map((skill) => ({ skill, code: failure.code ?? "INSTALL_FAILED", message: failure.error })) };
			}
			for (const p of plan.skills.filter((p) => names.includes(p.name))) {
				const failed = outcome.failed.find((f) => f.skill === p.name);
				if (failed || !outcome.installed.includes(p.name)) {
					record(p, "failed", { detail: failed?.message ?? "not installed", code: failed?.code ?? "NOT_INSTALLED" });
					// Whatever the library wrote before failing is ours: own it as
					// incomplete so the next run installs it again, rather than
					// finding a folder without a record (not ours) or one whose hash
					// moved (modified) and leaving it as it is.
					const on = diskState(p.name, env.dirs);
					if (on.shared === "dir" && on.hash) {
						const now = new Date().toISOString();
						state.owned[p.name] = { token: p.token.token, source: p.token.source, commit: p.commit, hash: on.hash, installedAt: state.owned[p.name]?.installedAt ?? now, updatedAt: now, incomplete: true };
					}
					continue;
				}
				let hash: string;
				try {
					hash = folderHash(join(env.dirs.shared, p.name));
				} catch (error) {
					record(p, "failed", { detail: `installed, but cannot read it back: ${message(error)}`, code: "NOT_INSTALLED" });
					continue;
				}
				const now = new Date().toISOString();
				state.owned[p.name] = { token: p.token.token, source: p.token.source, commit: p.commit, hash, installedAt: state.owned[p.name]?.installedAt ?? now, updatedAt: now };
				record(p, "installed", { commit: p.commit });
			}
		}
		for (const clash of plan.clashes) env.log(`${clash.name}: from ${clash.winner.token}; ${clash.token.token} also has it (earlier token wins)`);
		const counts = countResults(run);
		env.log(`done: ${counts.installed} installed, ${counts.skipped + plan.clashes.length} skipped, ${counts.modified} modified, ${counts.failed} failed`);
		run.results = Object.fromEntries(Object.entries(run.results).sort(([a], [b]) => (a < b ? -1 : 1)));
		run.clashes = plan.clashes.map((c) => ({ name: c.name, token: c.token.token, winner: c.winner.token }));
		return run;
	} finally {
		for (const handle of new Set(handles.values())) await handle.dispose().catch(() => {});
	}
}

function countResults(run: SkillsRun) {
	const counts = { installed: 0, skipped: 0, modified: 0, failed: 0 };
	for (const result of Object.values(run.results)) counts[result.state]++;
	return counts;
}

/** Whether anything in a run failed. */
function runFailed(run: SkillsRun): boolean {
	return Object.values(run.tokens).some((t) => t.state === "failed") || Object.values(run.results).some((r) => r.state === "failed");
}

/** Whether a later attempt could do better: a source that could not be fetched, or an install that failed. A skill name the source lacks will not appear by retrying. */
function runRetryable(run: SkillsRun): boolean {
	return Object.values(run.tokens).some((t) => t.state === "failed" && t.code !== NO_SUCH_SKILL) || Object.values(run.results).some((r) => r.state === "failed");
}

const NO_SUCH_SKILL = "SKILLS_NO_MATCHING_SKILLS";

/**
 * Sync the selection in rounds: one pass per round, then the back-off while
 * something failed (offline, rate-limited). The lock is held only during a
 * pass, so `t3app skills install` can run while the background run waits.
 * A waiting run whose selection is no longer the latest (another run with a
 * different selection finished meanwhile, say from a terminal with its own
 * T3APP_SKILLS) stops instead of applying its older one. Returns 0 when the
 * last pass had no failure or the run was superseded, 1 otherwise or when
 * another run holds the lock (interactive only).
 */
export async function syncSkills(selection: SkillSelection, mode: "install" | "update", env: SyncEnv): Promise<number> {
	const keepTrying = env.backoffMs.length > INTERACTIVE_BACKOFF_MS.length;
	const me: InstallerRecord = { pid: process.pid, startTicks: processStartTicks(process.pid), startedAt: new Date().toISOString() };
	let mine: string | null = null;
	for (let round = 0; ; round++) {
		const fd = tryLock(env.dir);
		let failed = true;
		let retry = true;
		let superseded: SkillsRun | null = null;
		if (fd === null) {
			if (!keepTrying) {
				env.log("another skills run is in progress; try again when it finishes (t3app skills status)");
				return 1;
			}
			env.log("another skills run is in progress; waiting for the next round");
		} else {
			try {
				const state = readSkillsState(env.dir);
				const other = state.last;
				if (round > 0 && other && other.id !== mine && selectionKey(parseSkills(other.selection)) !== selectionKey(selection)) {
					superseded = other;
					if (state.installer?.pid === me.pid && state.installer.startTicks === me.startTicks) {
						delete state.installer;
						writeSkillsState(env.dir, state);
					}
				} else {
					state.installer = { ...me };
					writeSkillsState(env.dir, state);
					const run = await syncOnce(selection, mode, state, env);
					state.last = run;
					mine = run.id;
					failed = runFailed(run);
					retry = runRetryable(run);
					const wait = env.backoffMs[round];
					if (retry && wait !== undefined) state.installer = { ...me, waitingUntil: new Date(Date.now() + wait).toISOString() };
					else delete state.installer;
					writeSkillsState(env.dir, state);
				}
			} finally {
				closeSync(fd);
			}
		}
		if (superseded) {
			env.log(`stopping: a run at ${superseded.at} applied another selection (${JSON.stringify(superseded.selection)}); it stands`);
			return 0;
		}
		if (!retry) return failed ? 1 : 0;
		const wait = env.backoffMs[round];
		if (wait === undefined) {
			env.log("giving up for now; the next container start retries (t3app skills install retries now)");
			return 1;
		}
		await env.sleep(wait);
	}
}

// --- status ----------------------------------------------------------------------

/**
 * installed: ours and as we wrote it. skipped: a clash or a folder that is
 * not ours. modified: ours, edited since (left alone). failed: the last run
 * could not install it. missing: ours, but its files are gone (the next run
 * installs it again while selected). kept: ours, no longer selected
 * (deselecting deletes nothing).
 */
export type SkillStateName = SkillResultState | "missing" | "kept";

export interface SkillStatus {
	name: string;
	state: SkillStateName;
	token: string;
	source: string;
	commit: string | null;
	detail?: string;
	code?: string;
}

export interface TokenStatus {
	token: string;
	source: string;
	/** pending: not resolved since the selection last changed. */
	state: "resolved" | "failed" | "pending";
	commit: string | null;
	skills: number;
	error?: string;
	code?: string;
}

export function buildSkillsStatus(raw: string | undefined | null, dir = stateDir(), dirs = skillDirs()) {
	const selection = parseSkills(raw);
	const state = readSkillsState(dir);
	const installer = state.installer && isSameProcess(state.installer) ? state.installer : null;
	const last = state.last ?? null;
	const current = last !== null && selectionKey(parseSkills(last.selection)) === selectionKey(selection);
	const tokens: TokenStatus[] = selection.tokens.map((t) => {
		const result = current ? last.tokens[t.token] : undefined;
		if (!result) return { token: t.token, source: t.source, state: "pending", commit: null, skills: 0 };
		return {
			token: t.token,
			source: t.source,
			state: result.state,
			commit: result.commit,
			skills: result.skills?.length ?? 0,
			...(result.error ? { error: result.error } : {}),
			...(result.code ? { code: result.code } : {}),
		};
	});
	const selectedTokens = new Set(selection.tokens.map((t) => t.token));
	const names = new Set([...Object.keys(state.owned), ...Object.keys(last?.results ?? {})]);
	const skills: SkillStatus[] = [];
	for (const name of [...names].sort()) {
		const owned = state.owned[name];
		const result = current ? last?.results[name] : undefined;
		const base = result ?? (owned ? { state: "installed" as const, token: owned.token, source: owned.source, commit: owned.commit } : null);
		if (!base) continue;
		let entry: SkillStatus = { name, ...base };
		// Ours but not chosen by the last run: deselected, or gone from a source that resolved.
		let kept: string | null = null;
		if (owned && !result && !selectedTokens.has(owned.token)) kept = "no longer selected; deselecting deletes nothing";
		else if (owned && !result && current && last.tokens[owned.token]?.state === "resolved") kept = `no longer in ${owned.source}; nothing deletes it`;
		if (owned && kept) entry = { name, state: "kept", token: owned.token, source: owned.source, commit: owned.commit, detail: kept };
		else if (owned && entry.state !== "skipped") {
			// Live: the user may have edited or removed it since the last run.
			const on = diskState(name, dirs);
			if (on.shared === "absent") entry = { ...entry, state: "missing", detail: "files gone; the next run installs it again while selected" };
			else if (on.shared === "other" || on.claude === "other" || on.hash !== owned.hash) entry = { ...entry, state: "modified", detail: entry.detail ?? "edited since it was installed; left alone" };
			else if (entry.state === "modified") entry = { name, state: "installed", token: owned.token, source: owned.source, commit: owned.commit };
			else if (owned.incomplete && entry.state !== "failed") entry = { ...entry, state: "failed", detail: "the last install failed partway; the next run installs it again" };
		}
		skills.push(entry);
	}
	const clashes = current ? (last?.clashes ?? []) : [];
	return {
		selector: selection,
		installer,
		lastRun: last ? { at: last.at, mode: last.mode, selection: last.selection, current } : null,
		tokens,
		skills,
		clashes,
		dirs,
		stateDir: dir,
		notes: [
			`Unset or empty ${SKILLS_ENV} selects the default "${DEFAULT_SKILLS}"; "none" installs nothing. Tokens: owner/repo, owner/repo@skill, owner/repo#ref, separated by spaces.`,
			"On a name clash the earlier token wins; a skill folder this image did not install is never written over.",
			"New or changed skills reach a running agent after Restart agent session in T3.",
			"Deselecting deletes nothing; remove a skill with npx skills remove -g <name>.",
		],
	};
}

export type SkillsStatus = ReturnType<typeof buildSkillsStatus>;

/** One line for the container log and `t3app status`. */
export function skillsSummary(status: Pick<SkillsStatus, "tokens" | "skills" | "selector">): string {
	if (status.selector.tokens.length === 0) return "none";
	const count = (state: SkillStateName) => status.skills.filter((s) => s.state === state).length;
	const tokens = status.tokens.map((t) => `${t.token}=${t.state}`).join(" ");
	const parts = [`${count("installed")} installed`];
	for (const state of ["skipped", "modified", "missing", "failed", "kept"] as const) if (count(state)) parts.push(`${count(state)} ${state}`);
	return `${tokens} (${parts.join(", ")})`;
}

const short = (commit: string | null) => (commit ? commit.slice(0, 7) : "-");

/** The report: tokens, then every skill (`full`) or only those that need a look. */
export function formatSkillsStatus(status: SkillsStatus, full = true): string {
	const sel = status.selector;
	const lines = [`${SKILLS_ENV}=${sel.raw === null ? "(unset)" : JSON.stringify(sel.raw)}${sel.defaulted ? " (default)" : ""} -> ${sel.tokens.length ? sel.tokens.map((t) => t.token).join(" ") : "none"}`];
	for (const t of status.tokens) {
		lines.push(`${t.token.padEnd(40)} ${t.state.padEnd(9)} ${short(t.commit)}${t.state === "resolved" ? `  ${t.skills} skill${t.skills === 1 ? "" : "s"}` : ""}`);
		if (t.error) lines.push(`${"".padEnd(41)}${t.code ? `${t.code}: ` : ""}${t.error}`);
	}
	const shown = full ? status.skills : status.skills.filter((s) => s.state !== "installed");
	if (shown.length) lines.push(full ? "skills:" : "skills needing a look:");
	for (const s of shown) lines.push(`  ${s.name.padEnd(32)} ${s.state.padEnd(9)} ${short(s.commit).padEnd(7)}  ${s.token}${s.detail ? `  (${s.code ? `${s.code}: ` : ""}${s.detail})` : ""}`);
	for (const c of status.clashes) lines.push(`  ${c.name.padEnd(32)} ${"skipped".padEnd(9)} ${"-".padEnd(7)}  ${c.token}  (clash: ${c.winner} is earlier)`);
	if (!full) lines.push(`summary: ${skillsSummary(status)}`);
	if (status.installer?.waitingUntil) lines.push(`run waiting; retrying at ${status.installer.waitingUntil} (t3app skills install retries now)`);
	else if (status.installer) lines.push(`run in progress (pid ${status.installer.pid}, since ${status.installer.startedAt})`);
	if (status.lastRun && !status.lastRun.current) lines.push("the selection changed since the last run; the next start or t3app skills install applies it");
	else if (!status.lastRun && sel.tokens.length) lines.push("no run yet; the next start or t3app skills install runs one");
	for (const warning of sel.warnings) lines.push(`warning: ${warning}`);
	lines.push(`skills: ${status.dirs.shared} (Claude links: ${status.dirs.claude}); logs and state: ${status.stateDir}`);
	return `${lines.join("\n")}\n`;
}

// --- CLI ---------------------------------------------------------------------------

/** Where the background runs log: the entrypoint's and `t3app skills install|update`. */
export const installLogPath = () => join(stateDir(), "skills.log");

const COMMANDS = ["status", "install", "update", "init", "help"];

export const USAGE = `t3app skills: agent skills imported into the home (issue #46)

usage: t3app skills <command> [options]     (no command: status)
       t3app skills help | --help | <command> --help

Commands
  status [--json] [--skills <selection>]
      Each token and skill: installed, skipped (a clash, or a folder that is
      not ours), modified (edited by you; left alone), failed, missing or
      kept (installed earlier, no longer selected). Read-only; --skills
      evaluates another selection against the last run.
  install [--wait]
      Fetch every selected source and install what is missing or whose
      source changed. Skills already installed stay at their commit.
  update [--wait]
      Like install, and also move skills from a floating token (no #ref) to
      the source's newest commit. The container runs this at every start.
      Both start in the background and answer at once (RouterOS drops a
      /container/shell reply after about 60 s) with the log to follow; "t3app
      status" shows progress. --wait runs it here: ${INTERACTIVE_BACKOFF_MS.length + 1} attempts, exit 1 if
      something still failed.

Internal (the container's entrypoint runs these)
  init
      Log selection warnings and a one-line summary. Never fails; offline.
  update --keep-trying
      The background run at start: retries for about a day while a source
      cannot be fetched (the router's uplink may come up late).

Selection (${SKILLS_ENV})
  Tokens separated by spaces, in the skills CLI's syntax:
    owner/repo            every skill in a GitHub repository
    owner/repo@skill      one skill from it
    owner/repo#ref        pinned to a branch, tag or commit (also with @skill)
    none                  install nothing
  Unset or empty: the default "${DEFAULT_SKILLS}". Tokens from the same
  repository and ref are fetched once. On a name clash the earlier token
  wins. On RouterOS change it with /app/set environment= (keep the other
  entries; spaces, never commas), never by reapplying the YAML.

Rules
  Skills go to ~/.agents/skills/<name> (read by Codex and other agents) with
  a link in Claude's skills directory ($CLAUDE_CONFIG_DIR/skills, else
  ~/.claude/skills). A folder this image did not install is never written
  over, and one you edited is left alone. Deselecting deletes nothing (npx
  skills remove -g <name> does). Agents see new skills after Restart agent
  session. Telemetry is off. Set GH_TOKEN for GitHub's higher rate limit.
  install and update refuse to run as root (exit 3).

Files (${stateDir()})
  skills.log          output of the background runs
  skills.json         what this image installed (ownership) and the last run
  skills.lock         held while a run is in progress

Exit codes: 0 ok (install, update: started, or already running), 1 something
failed or another run holds the lock (--wait), 2 usage, 3 root.
`;

/** Start `<command> --wait` in the background unless a run is in progress (startOnce makes it atomic). */
function startRun(command: "install" | "update"): number {
	const log = installLogPath();
	const launch = startOnce(`skills ${command}`, [process.execPath, "--no-install", import.meta.path, command, "--wait"], log, () => {
		const installer = readSkillsState(stateDir()).installer;
		if (installer && !installer.waitingUntil && isSameProcess(installer)) return installer;
		return lockHolder(join(stateDir(), "skills.lock"));
	});
	if (launch.started) {
		process.stdout.write(`t3app skills ${command}: started in the background (pid ${launch.pid})\nlog: ${log}\nprogress: t3app status\n`);
		return 0;
	}
	process.stdout.write(`t3app skills ${command}: already running (pid ${pidLabel(launch.running)}, since ${launch.running.startedAt})\nlog: ${log}\nprogress: t3app status\n`);
	return 0;
}

/** The `t3app skills` CLI (see USAGE); returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
	const [command = "status", ...rest] = argv;
	const raw = process.env[SKILLS_ENV];
	const help = helpRequest(command, rest, COMMANDS);
	if (help) {
		(help === "help" ? process.stdout : process.stderr).write(USAGE);
		return help === "help" ? 0 : 2;
	}
	if (command === "init") {
		if (rest.length > 0) {
			process.stderr.write(USAGE);
			return 2;
		}
		try {
			const status = buildSkillsStatus(raw);
			for (const warning of status.selector.warnings) console.error(`t3app skills: warning: ${warning}`);
			console.error(`t3app skills: skills ${skillsSummary(status)}`);
		} catch (error) {
			console.error(`t3app skills: warning: status unavailable: ${String(error)}`);
		}
		return 0;
	}
	if (command === "install" || command === "update") {
		if (rest.length > 1 || rest.some((arg) => arg !== "--keep-trying" && arg !== "--wait")) {
			process.stderr.write(USAGE);
			return 2;
		}
		if (process.getuid?.() === 0) {
			process.stderr.write(`t3app skills ${command}: run it as the app user (node), not root; it writes into that user's home (drop user=root)\n`);
			return 3;
		}
		if (rest.length === 0) return startRun(command);
		const selection = parseSkills(raw);
		for (const warning of selection.warnings) console.error(`t3app skills: warning: ${warning}`);
		return await syncSkills(selection, command, defaultSyncEnv(rest.includes("--keep-trying")));
	}
	if (command !== "status") {
		process.stderr.write(USAGE);
		return 2;
	}
	let json = false;
	let selection = raw;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--json") json = true;
		else if (arg === "--skills" && i + 1 < rest.length) selection = rest[++i];
		else if (arg?.startsWith("--skills=")) selection = arg.slice("--skills=".length);
		else {
			process.stderr.write(USAGE);
			return 2;
		}
	}
	const status = buildSkillsStatus(selection);
	process.stdout.write(json ? `${JSON.stringify(status, null, 2)}\n` : formatSkillsStatus(status));
	return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
