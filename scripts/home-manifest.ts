#!/usr/bin/env bun
/**
 * home-manifest — read-only, metadata-only content manifest of an
 * app-t3code home (`/data`), for before/after comparisons across an
 * upgrade (issue #3). Runs inside the container with the baked Bun:
 *
 *   bun home-manifest.ts > manifest.json
 *   bun home-manifest.ts --compare before.json after.json
 *
 * It never prints credential contents. Secret and login files appear as
 * type/size/mtime/mode plus a sha256 that `--compare` reports only as
 * "changed". Publish comparisons, not raw manifests. The T3 database is
 * opened read-only. See .agents/skills/chr-app-lab/SKILL.md.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

const USERDATA = "/data/.t3/userdata";

// Tables whose full rows are hashed: projects, threads, their content and
// auth. A change in any of them across an upgrade needs an explanation.
const HASHED_TABLES = [
	"projection_projects",
	"orchestration_v2_projection_threads",
	"orchestration_v2_projection_messages",
	"orchestration_v2_projection_runs",
	"orchestration_v2_projection_turn_items",
	"orchestration_v2_projection_nodes",
	"orchestration_v2_events",
	"orchestration_events",
	"auth_sessions",
	"scheduled_tasks",
	"peer_environment_links",
];

const LOGIN_PATHS = [
	"/data/.codex/auth.json",
	"/data/.codex/config.toml",
	"/data/.claude/.credentials.json",
	"/data/.claude.json",
	"/data/.claude/settings.json",
	"/data/.config/gh",
	"/data/.config/gh/hosts.yml",
	"/data/.config/opencode",
	"/data/.local/share/opencode/auth.json",
	"/data/.local/bin/claude",
	"/data/.local/share/claude",
];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Fixed command strings from this file only; never interpolate discovered paths. */
function sh(command: string): string {
	const proc = Bun.spawnSync(["bash", "-c", command], { stdout: "pipe", stderr: "pipe" });
	return proc.stdout.toString().trim();
}

/**
 * Git by argv, no shell. `--no-optional-locks` keeps `status` from refreshing
 * `.git/index`, and `diff` runs no external diff or textconv drivers.
 */
export function git(root: string, args: string[]): string {
	const proc = Bun.spawnSync(["git", "--no-optional-locks", "-C", root, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
	});
	return proc.stdout.toString().trim();
}

function sha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function fileSha(path: string): string | null {
	return existsSync(path) && lstatSync(path).isFile() ? sha256(readFileSync(path)) : null;
}

/** An untracked entry by type: a file's content hash, a symlink's target. */
function entryId(path: string): string {
	const s = lstatSync(path);
	if (s.isSymbolicLink()) return `link:${readlinkSync(path)}`;
	if (s.isFile()) return `file:${sha256(readFileSync(path))}`;
	return `other:${s.mode.toString(8)}`;
}

function meta(path: string): Json {
	if (!existsSync(path) && !isLink(path)) return null;
	const s = lstatSync(path);
	const type = s.isDirectory() ? "dir" : s.isSymbolicLink() ? "link" : "file";
	const out: { [key: string]: Json } = {
		type,
		size: s.size,
		mtime: Math.floor(s.mtimeMs / 1000),
		mode: (s.mode & 0o7777).toString(8),
	};
	if (type === "file") out["sha256"] = fileSha(path);
	return out;
}

function isLink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function keyPaths(value: unknown, prefix = ""): string[] {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
	return Object.entries(value).flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k));
}

function database(): Json {
	const db = new Database(join(USERDATA, "statev2.sqlite"), { readonly: true });
	const tables = db
		.query("select name from sqlite_master where type = 'table' order by name")
		.values()
		.map((row) => String(row[0]));
	const count = (table: string) => Number(db.query(`select count(*) from "${table}"`).values()[0]?.[0]);
	const ids = (table: string) => {
		const cols = db.query(`pragma table_info("${table}")`).all() as Array<{ name: string; pk: number }>;
		const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk)[0] ?? cols[0];
		return db
			.query(`select "${pk?.name}" from "${table}"`)
			.values()
			.map((row) => String(row[0]))
			.sort();
	};
	const rowsHash = (table: string) => {
		const hash = createHash("sha256");
		let rows = 0;
		for (const row of db.query(`select * from "${table}" order by rowid`).values()) {
			hash.update(
				JSON.stringify(row.map((v) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v))),
			);
			rows++;
		}
		return { rows, sha256: hash.digest("hex") };
	};
	const has = (table: string) => tables.includes(table);
	const out: Json = {
		migrationMax: Number(db.query("select max(migration_id) from effect_sql_migrations").values()[0]?.[0]),
		migrations: db
			.query("select migration_id, name from effect_sql_migrations where migration_id >= 70 order by 1")
			.values() as Json,
		counts: Object.fromEntries(
			tables.filter((t) => !t.startsWith("orchestration_v2_message_search_")).map((t) => [t, count(t)]),
		),
		projectIds: has("projection_projects") ? ids("projection_projects") : [],
		threadIds: has("orchestration_v2_projection_threads") ? ids("orchestration_v2_projection_threads") : [],
		rowHashes: Object.fromEntries(HASHED_TABLES.filter(has).map((t) => [t, rowsHash(t)])),
	};
	db.close();
	return out;
}

function repos(): Json {
	const roots: string[] = [];
	const walk = (dir: string, depth: number) => {
		if (existsSync(join(dir, ".git"))) {
			roots.push(dir);
			return;
		}
		if (depth >= 3) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1);
		}
	};
	for (const base of ["/data/projects", "/data/tikoci", "/data/.t3/worktrees", "/data/.t3/scratch", "/data/.t3/projects"]) {
		if (existsSync(base)) walk(base, 0);
	}
	return Object.fromEntries(
		roots.sort().map((root) => {
			const porcelain = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
			return [
				root,
				{
					head: git(root, ["rev-parse", "HEAD"]),
					branch: git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
					dirtyEntries: porcelain.split("\n").filter(Boolean).length,
					statusSha: sha256(porcelain),
					diffSha: sha256(git(root, ["diff", "--no-ext-diff", "--no-textconv", "HEAD"])),
					untrackedSha: sha256(
						git(root, ["ls-files", "-z", "--others", "--exclude-standard"])
							.split("\0")
							.filter(Boolean)
							.map((f) => `${f}\0${entryId(join(root, f))}`)
							.join("\0"),
					),
					worktrees: git(root, ["worktree", "list", "--porcelain"]),
					stashSha: sha256(git(root, ["stash", "list", "--format=%H"])),
				},
			];
		}),
	);
}

function toolsStatus(): Json {
	// Before and after an upgrade: images from #45 on have t3app, older ones t3code-tools.
	const raw = sh("t3app tools status --json 2>/dev/null || t3code-tools status --json");
	try {
		const full = JSON.parse(raw);
		return {
			core: full.core.state,
			selected: full.selector.selected,
			groups: Object.fromEntries(
				full.groups.map((g: { name: string; state: string; payload?: Record<string, Json> }) => [
					g.name,
					{
						state: g.state,
						desired: g.payload?.["desired"] ?? null,
						active: g.payload?.["active"] ?? null,
						installed: g.payload?.["installed"] ?? null,
					},
				]),
			),
		};
	} catch {
		// Never echo unparsed output: it is not known to be metadata.
		return { unparsed: true, bytes: raw.length };
	}
}

function manifest(): Json {
	const secretsDir = join(USERDATA, "secrets");
	let settingsKeys: Json;
	try {
		settingsKeys = keyPaths(JSON.parse(readFileSync(join(USERDATA, "settings.json"), "utf8"))).sort();
	} catch (error) {
		// A fixed category only: parser messages quote the input text.
		settingsKeys = error instanceof SyntaxError ? "invalid-json" : "unreadable";
	}
	const commands = ["t3", "codex", "opencode", "claude", "gh", "muse", "bun", "quickchr", "centrs"];
	return {
		versions: Object.fromEntries(commands.map((c) => [c, sh(`${c} --version 2>&1 | head -1`)])),
		which: Object.fromEntries(commands.map((c) => [c, sh(`command -v ${c}`) || null])),
		env: Object.fromEntries(
			["T3CODE_VER", "HOME", "T3CODE_HOME", "T3APP_TOOL_GROUPS", "T3APP_PROVIDERS", "T3CODE_TOOL_GROUPS", "T3CODE_PROVIDERS"].map((k) => [k, process.env[k] ?? null]),
		),
		environmentId: readFileSync(join(USERDATA, "environment-id"), "utf8").trim(),
		identityFiles: Object.fromEntries(
			["environment-id", "anonymous-id", "keybindings.json", "settings.json"].map((n) => [n, fileSha(join(USERDATA, n))]),
		),
		settingsKeys,
		secrets: Object.fromEntries(readdirSync(secretsDir).sort().map((n) => [n, meta(join(secretsDir, n))])),
		logins: Object.fromEntries(LOGIN_PATHS.map((p) => [p, meta(p)])),
		ghAuthExit: sh("gh auth status >/dev/null 2>&1; echo $?"),
		toolsStatus: toolsStatus(),
		db: database(),
		repos: repos(),
		df: sh("df -BM /data | tail -1"),
	};
}

function flatten(value: Json, prefix = ""): Map<string, string> {
	const out = new Map<string, string>();
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		for (const [k, v] of Object.entries(value)) {
			for (const [path, leaf] of flatten(v, prefix ? `${prefix}.${k}` : k)) out.set(path, leaf);
		}
	} else {
		out.set(prefix, JSON.stringify(value));
	}
	return out;
}

/** Changed, added and removed paths; secret and login hashes only as "changed". */
function compare(beforePath: string, afterPath: string): string[] {
	const [a, b] = [beforePath, afterPath].map((p) => flatten(JSON.parse(readFileSync(p, "utf8"))));
	const hidden = (path: string) => /^(secrets|logins)\..*\.sha256$/.test(path);
	const lines: string[] = [];
	for (const path of [...new Set([...(a?.keys() ?? []), ...(b?.keys() ?? [])])].sort()) {
		const [x, y] = [a?.get(path), b?.get(path)];
		if (x === y) continue;
		if (x === undefined) lines.push(`+ ${path} = ${hidden(path) ? "<hash>" : y}`);
		else if (y === undefined) lines.push(`- ${path}`);
		else lines.push(hidden(path) ? `~ ${path}: changed` : `~ ${path}: ${x} -> ${y}`);
	}
	return lines;
}

if (import.meta.main) {
	const [flag, before, after] = process.argv.slice(2);
	if (flag === "--compare" && before && after) console.log(compare(before, after).join("\n"));
	else console.log(JSON.stringify(manifest(), null, 1));
}
