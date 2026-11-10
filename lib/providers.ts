// T3APP_PROVIDERS: which provider (harness) runtimes this image installs into
// the home, one explicit token per provider in T3's main Add provider list
// (issue #13). Separate from T3APP_TOOL_GROUPS: groups are tools for agents,
// providers are the agents themselves. The catalog is lib/harnesses.ts.
//
// Installs act only while a provider's CLI is missing from PATH and install
// the way a user would (npm into /data/.local, the vendor's installer, or
// bin/install-claude-code), so T3's own Update now keeps working and a CLI the
// user installed always wins. Deselecting never deletes anything. Cursor and
// Antigravity are T3's own (a bundled SDK, a runtime T3 downloads): their
// tokens are accepted and install nothing.
//
// Never throw on operator input: an unknown token is a warning, and T3 must
// always start. The image copies lib/ to /usr/local/lib/t3app/; lib/t3app.ts
// dispatches `t3app providers` here.
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES, type Harness, type Install } from "./harnesses.ts";
import {
	type Child,
	DISK_RESERVE_BYTES,
	helpRequest,
	INTERACTIVE_BACKOFF_MS,
	isSameProcess,
	KEEP_TRYING_BACKOFF_MS,
	kernelFlock,
	LOCK_EX,
	LOCK_NB,
	processStartTicks,
	startInBackground,
	stateDir,
	stopChild,
	waitGone,
} from "./runtime.ts";

export const PROVIDERS_ENV = "T3APP_PROVIDERS";
/** The shipped default: an explicit list, so a provider added later is never enabled silently. */
export const DEFAULT_PROVIDERS = "claude codex";

export interface Provider extends Harness {
	token: string;
	install: Install;
}

/** The selectable providers, in T3's catalog order. */
export const PROVIDERS: readonly Provider[] = Object.values(HARNESSES).filter((h): h is Provider => Boolean(h.token && h.install));
export const PROVIDER_TOKENS: readonly string[] = PROVIDERS.map((p) => p.token);

/** T3 drivers this image does not install, by the name an operator might type. */
const NOT_SELECTABLE = new Map(
	Object.values(HARNESSES)
		.filter((h) => !h.token)
		.map((h) => [h.label.toLowerCase().replace(/\s+/g, "-"), h.label]),
);

export interface ProviderSelection {
	variable: string;
	raw: string | null;
	defaulted: boolean;
	selected: string[];
	unknown: string[];
	warnings: string[];
}

/**
 * Parse T3APP_PROVIDERS like T3APP_TOOL_GROUPS: whitespace, `+` or comma
 * separated, case-insensitive. Unset or empty is DEFAULT_PROVIDERS; `none`
 * installs nothing. There is no `all`: a provider T3 adds later is never
 * installed without someone choosing it.
 */
export function parseProviders(raw: string | undefined | null): ProviderSelection {
	const defaulted = (raw ?? "").trim() === "";
	const selection: ProviderSelection = { variable: PROVIDERS_ENV, raw: raw ?? null, defaulted, selected: [], unknown: [], warnings: [] };
	const tokens = (defaulted ? DEFAULT_PROVIDERS : (raw as string))
		.split(/[\s+,]+/)
		.map((token) => token.trim().toLowerCase())
		.filter(Boolean);
	const chosen = new Set<string>();
	let sawNone = false;
	for (const token of tokens) {
		if (token === "none") sawNone = true;
		else if (PROVIDER_TOKENS.includes(token)) chosen.add(token);
		else if (!selection.unknown.includes(token)) selection.unknown.push(token);
	}
	for (const token of selection.unknown) {
		const label = NOT_SELECTABLE.get(token);
		selection.warnings.push(
			label
				? `${PROVIDERS_ENV}: ${label} is not installed by this image (install it yourself, or open an issue to add it); "${token}" ignored`
				: `${PROVIDERS_ENV}: unknown provider "${token}" ignored (known: ${PROVIDER_TOKENS.join(", ")}, none)`,
		);
	}
	if (sawNone && chosen.size > 0) selection.warnings.push(`${PROVIDERS_ENV}: "none" combined with other providers; using the other providers`);
	selection.selected = PROVIDER_TOKENS.filter((token) => chosen.has(token));
	return selection;
}

// --- state ---------------------------------------------------------------

export interface ProviderRecord {
	state: "installing" | "ready" | "failed";
	at: string;
	error?: string;
}

export interface InstallerRecord {
	pid: number;
	startTicks: string | null;
	startedAt: string;
	/** Set while the installer waits between rounds (it holds no lock then). */
	waitingUntil?: string;
	/** The install step running now, in its own process group. */
	child?: Child;
}

export interface ProviderState {
	installer?: InstallerRecord;
	providers: Record<string, ProviderRecord>;
}

export function readProviderState(dir: string): ProviderState {
	try {
		const state = JSON.parse(readFileSync(join(dir, "providers.json"), "utf8")) as ProviderState;
		return { ...state, providers: state.providers ?? {} };
	} catch {
		return { providers: {} };
	}
}

/** Only the lock holder writes the state. */
function writeProviderState(dir: string, state: ProviderState) {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "providers.json");
	writeFileSync(`${path}.${process.pid}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
	renameSync(`${path}.${process.pid}.tmp`, path);
}

// --- status ----------------------------------------------------------------

/**
 * `t3-managed`: T3 provides it (nothing to install here). `pending`: selected,
 * no installer is working on it yet. `installing`: an installer is working on
 * it or waiting to retry it. `failed`: the last attempt failed and no
 * installer is running.
 */
export type ProviderStateName = "not-selected" | "t3-managed" | "ready" | "pending" | "installing" | "failed";

export interface ProviderStatus {
	token: string;
	label: string;
	selected: boolean;
	state: ProviderStateName;
	install: Install["kind"];
	cli: string | null;
	/** Where the CLI resolves on PATH, whoever installed it. */
	path: string | null;
	last: ProviderRecord | null;
	note?: string;
}

export type Which = (command: string) => string | null;

export function providerStatus(provider: Provider, selected: boolean, which: Which, state: ProviderState, installerAlive: boolean): ProviderStatus {
	const path = provider.cli ? which(provider.cli) : null;
	const last = state.providers[provider.token] ?? null;
	let name: ProviderStateName;
	if (!selected) name = "not-selected";
	else if (provider.install.kind === "t3") name = "t3-managed";
	else if (path) name = "ready";
	else if (installerAlive) name = "installing";
	else if (last?.state === "failed") name = "failed";
	else name = "pending";
	return {
		token: provider.token,
		label: provider.label,
		selected,
		state: name,
		install: provider.install.kind,
		cli: provider.cli ?? null,
		path,
		last,
		...(provider.note ? { note: provider.note } : {}),
	};
}

export function buildProviderStatus(raw: string | undefined | null, which: Which = (c) => Bun.which(c), dir = stateDir()) {
	const selection = parseProviders(raw);
	const state = readProviderState(dir);
	const installer = state.installer && isSameProcess(state.installer) ? state.installer : null;
	return {
		selector: selection,
		installer,
		providers: PROVIDERS.map((p) => providerStatus(p, selection.selected.includes(p.token), which, state, installer !== null)),
		stateDir: dir,
		notes: [
			`Unset or empty ${PROVIDERS_ENV} selects the default "${DEFAULT_PROVIDERS}"; "none" installs nothing. Installing is separate from enabling a provider in T3's Settings → Providers.`,
			"A CLI already on PATH is never replaced or updated here: after the first install, T3's Update now (or the CLI's own updater) owns it.",
			"Deselecting a provider deletes nothing: its CLI, login and history stay in /data.",
		],
	};
}

export type ProvidersStatus = ReturnType<typeof buildProviderStatus>;

/** One line for the container log and `t3app tools status`. */
export function providerSummary(providers: readonly Pick<ProviderStatus, "token" | "selected" | "state">[]): string {
	const selected = providers.filter((p) => p.selected);
	return selected.length ? selected.map((p) => `${p.token}=${p.state}`).join(" ") : "none";
}

export function formatProviderStatus(status: ProvidersStatus): string {
	const sel = status.selector;
	const lines = [`${PROVIDERS_ENV}=${sel.raw === null ? "(unset)" : JSON.stringify(sel.raw)}${sel.defaulted ? " (default)" : ""} -> ${sel.selected.length ? sel.selected.join(" ") : "none"}`];
	for (const p of status.providers) {
		const where = p.path ?? (p.cli ? `no ${p.cli} on PATH` : "provided by T3");
		lines.push(`${p.token.padEnd(12)} ${p.state.padEnd(13)} ${where}`);
		if (p.selected && p.state !== "ready" && p.last?.error) lines.push(`${"".padEnd(13)}last error: ${p.last.error}`);
	}
	if (status.installer?.waitingUntil) lines.push(`installer waiting; retrying at ${status.installer.waitingUntil} (t3app providers install retries now)`);
	for (const warning of sel.warnings) lines.push(`warning: ${warning}`);
	lines.push(`logs and state: ${status.stateDir}`);
	return `${lines.join("\n")}\n`;
}

// --- install -----------------------------------------------------------------

/** Longest one provider install may run before it is stopped and retried. */
export const INSTALL_TIMEOUT_MS = 2 * 60 * 60_000;

export interface InstallEnv {
	dir: string;
	which: Which;
	backoffMs: readonly number[];
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
	/** Free bytes on the volume holding `dir` (the home). */
	freeBytes: (path: string) => number;
	/** Runs one installer step and reports its process; resolves to its exit code. */
	run: (argv: string[], env: Record<string, string>, onSpawn: (child: Child) => void) => Promise<number>;
}

export function defaultInstallEnv(keepTrying: boolean): InstallEnv {
	return {
		dir: stateDir(),
		which: (c) => Bun.which(c),
		backoffMs: keepTrying ? KEEP_TRYING_BACKOFF_MS : INTERACTIVE_BACKOFF_MS,
		sleep: (ms) => Bun.sleep(ms),
		log: (line) => console.log(`${new Date().toISOString()} t3app providers: ${line}`),
		freeBytes: (path) => {
			const fs = statfsSync(path);
			return Number(fs.bavail) * Number(fs.bsize);
		},
		run: async (argv, env, onSpawn) => {
			// util-linux setsid (not a group leader, so it execs in place): the
			// step gets its own process group, so a timeout, or the next
			// installer after this one died, stops npm or a vendor script with
			// everything it started.
			const proc = Bun.spawn(["setsid", ...argv], { env: { ...process.env, ...env }, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
			const child = { pid: proc.pid, startTicks: processStartTicks(proc.pid), processGroup: true };
			onSpawn(child);
			const timer = setTimeout(() => stopChild(child), INSTALL_TIMEOUT_MS);
			try {
				return await proc.exited;
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

/** The commands that install one provider (none for T3-managed ones). */
export function installSteps(provider: Provider, dir: string): { argv: string[]; env: Record<string, string> }[] {
	const install = provider.install;
	if (install.kind === "npm") return [{ argv: ["npm", "install", "--global", "--no-fund", "--no-audit", ...(install.flags ?? []), install.package], env: {} }];
	if (install.kind === "command") return [{ argv: [...install.argv], env: {} }];
	if (install.kind === "script") {
		const script = join(dir, "downloads", `${provider.token}-install.sh`);
		return [
			{ argv: ["curl", "-fsSL", "--proto", "=https", "--retry", "3", "--create-dirs", "-o", script, install.url], env: {} },
			{ argv: ["bash", script], env: { ...install.env } },
		];
	}
	return [];
}

function tryLock(dir: string): number | null {
	mkdirSync(dir, { recursive: true });
	// Never unlinked: a waiter must not lock an orphaned inode.
	const fd = openSync(join(dir, "providers.lock"), "a+");
	if (kernelFlock(fd, LOCK_EX | LOCK_NB)) {
		ftruncateSync(fd, 0);
		writeSync(fd, `${process.pid}\n`, 0);
		return fd;
	}
	closeSync(fd);
	return null;
}

/** Free space one install needs: twice its installed size (download, npm cache, staging) plus the tool-group reserve. */
export function requiredBytes(provider: Provider): number {
	return (provider.approxMiB ?? 0) * 2 * 1024 * 1024 + DISK_RESERVE_BYTES;
}

/** Install one provider; returns an error message, or null once its CLI is on PATH. */
async function installOne(provider: Provider, env: InstallEnv, recordChild: (child: Child | null) => void): Promise<string | null> {
	const need = requiredBytes(provider);
	const free = env.freeBytes(env.dir);
	if (free < need) return `low disk: needs about ${Math.ceil(need / 1048576)} MiB free in ${env.dir}, ${Math.floor(free / 1048576)} MiB free`;
	for (const step of installSteps(provider, env.dir)) {
		env.log(`${provider.token}: ${step.argv.join(" ")}`);
		let code: number;
		try {
			code = await env.run(step.argv, step.env, recordChild);
		} catch (error) {
			return `could not start ${step.argv[0]}: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			recordChild(null);
		}
		if (code !== 0) return `${step.argv[0]} exited ${code}`;
	}
	rmSync(join(env.dir, "downloads", `${provider.token}-install.sh`), { force: true });
	if (provider.cli && !env.which(provider.cli)) return `installed, but no ${provider.cli} on PATH`;
	return null;
}

/**
 * Install every selected provider whose CLI is missing, in rounds: one
 * attempt each per round, then the back-off. The lock is held only during a
 * round, so `t3app providers install` from a terminal can run while the
 * background installer waits; only the lock holder writes the state. An
 * install step left running by an installer that died is stopped first.
 * Returns 0 when every selected CLI is present, 1 on failure or when another
 * installer holds the lock (interactive only).
 */
export async function installProviders(selected: readonly string[], env: InstallEnv): Promise<number> {
	const wanted = PROVIDERS.filter((p) => selected.includes(p.token) && p.install.kind !== "t3");
	const me: InstallerRecord = { pid: process.pid, startTicks: processStartTicks(process.pid), startedAt: new Date().toISOString() };
	const keepTrying = env.backoffMs.length > INTERACTIVE_BACKOFF_MS.length;
	for (let round = 0; ; round++) {
		const fd = tryLock(env.dir);
		let missing: Provider[] = [];
		if (fd === null) {
			if (!keepTrying) {
				env.log("another provider install is running; try again when it finishes (t3app providers status)");
				return 1;
			}
			env.log("another provider install is running; waiting for the next round");
			missing = wanted;
		} else {
			try {
				const state = readProviderState(env.dir);
				const orphan = state.installer?.child;
				if (orphan && stopChild(orphan)) {
					env.log(`stopping install step pid ${orphan.pid}, left running by an interrupted installer`);
					await waitGone(orphan);
				}
				state.installer = { ...me };
				missing = wanted.filter((p) => p.cli && !env.which(p.cli));
				for (const p of wanted.filter((p) => !missing.includes(p))) {
					if (state.providers[p.token]?.state !== "ready") state.providers[p.token] = { state: "ready", at: new Date().toISOString() };
				}
				writeProviderState(env.dir, state);
				const recordChild = (child: Child | null) => {
					state.installer = child ? { ...me, child } : { ...me };
					writeProviderState(env.dir, state);
				};
				for (const provider of missing) {
					// A CLI that appeared during this round (T3's /welcome, a terminal) wins.
					if (provider.cli && env.which(provider.cli)) {
						state.providers[provider.token] = { state: "ready", at: new Date().toISOString() };
						writeProviderState(env.dir, state);
						continue;
					}
					state.providers[provider.token] = { state: "installing", at: new Date().toISOString() };
					writeProviderState(env.dir, state);
					const error = await installOne(provider, env, recordChild);
					state.providers[provider.token] = error ? { state: "failed", at: new Date().toISOString(), error } : { state: "ready", at: new Date().toISOString() };
					env.log(`${provider.token}: ${error ? `failed: ${error}` : "ready"}`);
					writeProviderState(env.dir, state);
				}
				missing = missing.filter((p) => state.providers[p.token]?.state !== "ready");
				const wait = env.backoffMs[round];
				if (missing.length && wait !== undefined) state.installer = { ...me, waitingUntil: new Date(Date.now() + wait).toISOString() };
				else delete state.installer;
				writeProviderState(env.dir, state);
			} finally {
				closeSync(fd);
			}
		}
		if (missing.length === 0) return 0;
		const wait = env.backoffMs[round];
		if (wait === undefined) {
			env.log(`giving up for now on ${missing.map((p) => p.token).join(", ")}; the next container start retries (t3app providers install retries now)`);
			return 1;
		}
		await env.sleep(wait);
	}
}

// --- CLI ---------------------------------------------------------------------

/** Where the background install logs: the entrypoint's run and `t3app providers install` share it. */
export const installLogPath = () => join(stateDir(), "providers.log");

const COMMANDS = ["status", "install", "init", "help"];

export const USAGE = `t3app providers: provider (agent) runtimes for the app-t3code image (issue #13)

usage: t3app providers <command> [options]     (no command: status)
       t3app providers help | --help | <command> --help

Commands
  status [--json] [--providers <selection>]
      Each provider's state and where its CLI resolves. --providers evaluates
      another selection without changing anything. Read-only.
  install [--wait]
      Install every selected provider whose CLI is not on PATH. Starts in the
      background and answers at once (RouterOS drops a /container/shell reply
      after about 60 s) with the log to follow; "t3app status" shows progress.
      If an install is already running it says so and starts nothing. --wait
      runs it here instead: ${INTERACTIVE_BACKOFF_MS.length + 1} rounds, exit 1 if a provider is still missing.

Internal (the container's entrypoint runs these)
  init
      Log selection warnings and a one-line summary. Never fails.
  install --keep-trying
      The background run at start: rounds for about a day, lock released
      between them, so "t3app providers install" (retry now) can run meanwhile.

Selection (${PROVIDERS_ENV})
  Tokens separated by spaces (or commas or +), case-insensitive:
  ${PROVIDER_TOKENS.join(", ")}.
  Unset or empty: the default "${DEFAULT_PROVIDERS}". "none": install nothing.
  cursor and antigravity are provided by T3 itself and install nothing here.
  On RouterOS change it with /app/set environment= (keep the other entries;
  use spaces), never by reapplying the YAML.

Rules
  A CLI already on PATH is never replaced: after the first install, T3's
  Update now or the CLI's own updater owns it. Deselecting deletes nothing.
  install refuses to run as root (exit 3): it installs into the app user's
  home. RouterOS /container/shell runs as that user (node) unless given user=.

Files (${stateDir()})
  providers.log       output of the background install (the entrypoint's and install's)
  providers.json      last result per provider
  providers.lock      held while an install round runs

Exit codes: 0 ok (install: started, or already running), 1 a provider is
still missing or another install holds the lock (--wait), 2 usage, 3 root.
`;

/**
 * `install` without --wait: start `install --wait` in the background, unless
 * an install round is running now. A --keep-trying run waiting out its
 * back-off holds no lock, so starting one is the "retry now".
 */
function startInstall(): number {
	const log = installLogPath();
	const running = readProviderState(stateDir()).installer;
	if (running && !running.waitingUntil && isSameProcess(running)) {
		process.stdout.write(`t3app providers install: already running (pid ${running.pid}, since ${running.startedAt})\nlog: ${log}\nprogress: t3app status\n`);
		return 0;
	}
	const pid = startInBackground("providers install", [process.execPath, import.meta.path, "install", "--wait"], log);
	process.stdout.write(`t3app providers install: started in the background (pid ${pid})\nlog: ${log}\nprogress: t3app status\n`);
	return 0;
}

/** The `t3app providers` CLI (see USAGE); returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
	const [command = "status", ...rest] = argv;
	const raw = process.env[PROVIDERS_ENV];
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
			const status = buildProviderStatus(raw);
			for (const warning of status.selector.warnings) console.error(`t3app providers: warning: ${warning}`);
			console.error(`t3app providers: providers ${providerSummary(status.providers)}`);
		} catch (error) {
			console.error(`t3app providers: warning: status unavailable: ${String(error)}`);
		}
		return 0;
	}
	if (command === "install") {
		if (rest.length > 1 || rest.some((arg) => arg !== "--keep-trying" && arg !== "--wait")) {
			process.stderr.write(USAGE);
			return 2;
		}
		if (process.getuid?.() === 0) {
			process.stderr.write("t3app providers install: run it as the app user (node), not root; it installs into that user's home (drop user=root)\n");
			return 3;
		}
		if (rest.length === 0) return startInstall();
		const selection = parseProviders(raw);
		for (const warning of selection.warnings) console.error(`t3app providers: warning: ${warning}`);
		return await installProviders(selection.selected, defaultInstallEnv(rest.includes("--keep-trying")));
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
		else if (arg === "--providers" && i + 1 < rest.length) selection = rest[++i];
		else if (arg?.startsWith("--providers=")) selection = arg.slice("--providers=".length);
		else {
			process.stderr.write(USAGE);
			return 2;
		}
	}
	const status = buildProviderStatus(selection);
	process.stdout.write(json ? `${JSON.stringify(status, null, 2)}\n` : formatProviderStatus(status));
	return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
