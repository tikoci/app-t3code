// t3code-tools: the command for optional tool groups (USAGE below is the
// reference). The groups are in tool-catalog.ts, the report in
// tool-status.ts, installs in tool-payloads.ts. The image copies lib/ to
// /usr/local/lib/t3code/ and bin/t3code-tools runs this file with Bun.
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { APP_HOME, DISK_RESERVE_BYTES, INTERACTIVE_BACKOFF_MS, KEEP_TRYING_BACKOFF_MS, stateDir } from "./runtime.ts";
import {
	CORE_CHECKS,
	DEFAULT_TOOL_GROUPS,
	GROUP_NAMES,
	GROUPS,
	NETWORK_PACKAGE_ASSIGNMENT,
	PAYLOAD_SPEC_DIR,
	parseToolGroups,
	SELECTOR_ENV,
} from "./tool-catalog.ts";
import { activateIfIdle, defaultPayloadEnv, defaultRoot, installGroups, isPayloadGroup, prunePayloads } from "./tool-payloads.ts";
import { BUILD_INVENTORY_DIR, buildStatus, formatStatus, RUNTIME_STATUS_PATH, writeRuntimeStatus } from "./tool-status.ts";

/** A back-off delay as 15s / 5m / 1h. */
const fmtWait = (ms: number) => (ms < 60_000 ? `${ms / 1000}s` : ms < 3_600_000 ? `${ms / 60_000}m` : `${ms / 3_600_000}h`);
const keepTryingHours = Math.round(KEEP_TRYING_BACKOFF_MS.reduce((a, b) => a + b, 0) / 3_600_000);

/**
 * The command reference: the one place that says what t3code-tools does.
 * `t3code-tools help` (or any command with --help) prints it. Keep it in
 * step with main(); a test checks every command is described.
 */
export const USAGE = `t3code-tools: optional tool groups for the app-t3code image (issue #5)

usage: t3code-tools <command> [options]        (no command: status)
       t3code-tools help | --help | <command> --help

Commands
  status [--json] [--groups <selection>]
      Report the selection, core readiness and each group's state, payload and
      last error. --groups evaluates another selection without changing
      anything. Read-only; safe at any time.
  install [--keep-trying]
      Install missing payloads for the selection, one group at a time, then
      link them. Without --keep-trying: ${INTERACTIVE_BACKOFF_MS.length + 1} attempts per group over about
      ${fmtWait(INTERACTIVE_BACKOFF_MS.reduce((a, b) => a + b, 0))} (use this to retry now). --keep-trying is the entrypoint's
      background run: retries for about ${keepTryingHours}h (${KEEP_TRYING_BACKOFF_MS.slice(0, 5).map(fmtWait).join(", ")}, then hourly) and
      releases the lock between rounds, so a manual install or prune can run.
      Exit 1 if a group ended failed.
  prune
      Delete payloads no selected group uses (deselected groups, the previous
      payload kept after a refresh), interrupted installs and kept downloads.
      Exit 1 while an installer holds the lock.
  init
      Entrypoint hook: relink already-installed payloads for the selection,
      unlink deselected ones, log warnings and write the status file. Offline,
      bounded, never fails.
  groups
      Print the group definitions, core checks and network package assignment
      as JSON (the static spec this image ships).

Selection (${SELECTOR_ENV})
  Group names separated by spaces (or commas or +), case-insensitive:
  ${GROUP_NAMES.join(", ")}.
  Unset or empty: the default "${DEFAULT_TOOL_GROUPS}". "none": core only.
  "all": every group, including ones added later. Unknown names are ignored
  with a warning. On RouterOS change it with /app/set environment= (keep the
  other entries; use spaces), never by reapplying the YAML.

Files
  ${defaultRoot()}
      payload root (T3CODE_TOOLS_HOME moves it): groups/<group>/<id>, bin/
      shims on PATH, state.json, install.log, install.lock
  ${RUNTIME_STATUS_PATH}
      status JSON written by init and install
  ${join(stateDir(), "tool-groups.log")}
      output of the entrypoint's background install
  ${BUILD_INVENTORY_DIR}
      build-time inventory (image contents, deb locks)

Users
  install, prune and init must run as the owner of the payload root (node in
  this image). Run as root (for example RouterOS /container/shell), they
  re-execute as that owner with setpriv, so files never become root-owned;
  root always means the app's payload root (${APP_HOME}), whatever its HOME.
  A waiting background installer is recorded in install.wait.

Exit codes: 0 ok, 1 a group failed or the lock is busy (prune), 2 usage,
3 wrong user and cannot switch. Installing a group grants no privileges;
each group's "privileges" field says what its operations need. Each install
needs its payload and downloads plus ${DISK_RESERVE_BYTES / 1024 / 1024} MiB free.
`;

const COMMANDS = ["status", "install", "prune", "init", "groups", "help"] as const;

/** Commands that write the payload root, so must run as its owner. */
const OWNER_COMMANDS = new Set(["install", "prune", "init"]);

/** The nearest existing directory at or above path (the payload root may not exist yet). */
function existingAncestor(path: string): string {
	let p = path;
	while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
	return p;
}

function writable(path: string): boolean {
	try {
		accessSync(path, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Who should run a command that writes the payload root: null when this
 * process owns it (or the platform has no uids), else the owner. A root
 * that does not exist yet belongs to whoever creates it: a non-root caller
 * may create it under any parent it can write (a shared /tmp, say); root
 * defers to the parent's owner, so the app's home never gains root-owned files.
 */
export function ownerMismatch(root: string, uid: number | undefined = process.getuid?.()): { uid: number; gid: number; path: string } | null {
	if (uid === undefined) return null;
	const path = existingAncestor(root);
	const st = statSync(path);
	if (st.uid === uid) return null;
	if (path !== root && uid !== 0 && writable(path)) return null;
	return { uid: st.uid, gid: st.gid, path };
}

/**
 * Run as the payload root's owner: root re-executes this command through
 * setpriv (so /container/shell, which may be root, leaves no root-owned
 * files); anyone else gets exit 3. Returns null when no switch is needed.
 */
function runAsOwner(command: string, argv: string[]): number | null {
	const owner = ownerMismatch(defaultRoot());
	if (!owner) return null;
	const uid = process.getuid?.();
	if (uid !== 0) {
		process.stderr.write(`t3code-tools ${command}: ${owner.path} belongs to uid ${owner.uid}, this is uid ${uid}; run it as that user\n`);
		return 3;
	}
	// Pin the payload root and home for the child: root's HOME (often /root)
	// would otherwise point the app user's run somewhere else.
	const env = { ...process.env, HOME: APP_HOME, T3CODE_TOOLS_HOME: defaultRoot() };
	const proc = Bun.spawnSync(
		["setpriv", `--reuid=${owner.uid}`, `--regid=${owner.gid}`, "--clear-groups", "--", process.execPath, import.meta.path, ...argv],
		{ stdin: "inherit", stdout: "inherit", stderr: "inherit", env },
	);
	if (proc.exitCode === null || (proc.exitCode === 127 && !Bun.which("setpriv"))) {
		process.stderr.write(`t3code-tools ${command}: running as root and cannot switch to uid ${owner.uid} (setpriv unavailable)\n`);
		return 3;
	}
	return proc.exitCode;
}

/** The t3code-tools CLI (see USAGE); returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
	const [command = "status", ...rest] = argv;
	const raw = process.env[SELECTOR_ENV];
	if (command === "-h" || command === "--help" || command === "help" || rest.includes("--help") || rest.includes("-h")) {
		if (command !== "-h" && command !== "--help" && !(COMMANDS as readonly string[]).includes(command)) {
			process.stderr.write(USAGE);
			return 2;
		}
		process.stdout.write(USAGE);
		return 0;
	}
	// Reject stray arguments before anything else, including the switch to the owner.
	const strayArgs = command === "install" ? rest.some((arg) => arg !== "--keep-trying") : (command === "prune" || command === "groups") && rest.length > 0;
	if (strayArgs) {
		process.stderr.write(USAGE);
		return 2;
	}
	if (OWNER_COMMANDS.has(command)) {
		const code = runAsOwner(command, argv);
		if (code !== null) return code;
	}
	if (command === "groups") {
		process.stdout.write(`${JSON.stringify({ groups: GROUPS, core: CORE_CHECKS, networkPackageAssignment: NETWORK_PACKAGE_ASSIGNMENT }, null, 2)}\n`);
		return 0;
	}
	if (command === "init") {
		const selection = parseToolGroups(raw);
		try {
			// Serialized with install/prune; if one is running it activates instead.
			const pending = await activateIfIdle(GROUPS.filter(isPayloadGroup), selection.selected, defaultPayloadEnv(PAYLOAD_SPEC_DIR));
			if (pending === null) console.error("t3code-tools: an install or prune is running; it will relink payloads when done");
		} catch (error) {
			console.error(`t3code-tools: warning: payload activation failed: ${String(error)}`);
		}
		const status = writeRuntimeStatus(raw);
		if (status) {
			for (const warning of status.selector.warnings) console.error(`t3code-tools: warning: ${warning}`);
			const summary = status.groups.filter((g) => g.selected).map((g) => `${g.name}=${g.state}`);
			console.error(`t3code-tools: groups ${summary.length ? summary.join(" ") : "none (core only)"}; core ${status.core.state}`);
		}
		return 0;
	}
	if (command === "install") {
		const selection = parseToolGroups(raw);
		const env = defaultPayloadEnv(PAYLOAD_SPEC_DIR);
		if (rest.includes("--keep-trying")) env.backoffMs = KEEP_TRYING_BACKOFF_MS;
		const result = await installGroups(GROUPS.filter(isPayloadGroup), selection.selected, env, () => writeRuntimeStatus(raw));
		writeRuntimeStatus(raw);
		return Object.values(result.results).some((r) => r.state === "failed") ? 1 : 0;
	}
	if (command === "prune") {
		const selection = parseToolGroups(raw);
		try {
			const removed = await prunePayloads(GROUPS.filter(isPayloadGroup), selection.selected, defaultPayloadEnv(PAYLOAD_SPEC_DIR));
			process.stdout.write(removed.length ? `removed ${removed.join(" ")}\n` : "nothing to remove\n");
		} catch (error) {
			process.stderr.write(`t3code-tools: ${error instanceof Error ? error.message : String(error)}\n`);
			return 1;
		}
		writeRuntimeStatus(raw);
		return 0;
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
		else if (arg === "--groups" && i + 1 < rest.length) selection = rest[++i];
		else if (arg?.startsWith("--groups=")) selection = arg.slice("--groups=".length);
		else {
			process.stderr.write(USAGE);
			return 2;
		}
	}
	const status = buildStatus(selection);
	process.stdout.write(json ? `${JSON.stringify(status, null, 2)}\n` : formatStatus(status));
	return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
