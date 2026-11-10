// The agent-facing status report (`t3code-tools status`, and the JSON the
// entrypoint writes): selection, core readiness, each group's state and
// payload, and a summary of the provider CLIs. Presence probes only.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildProviderStatus, PROVIDERS_ENV, providerSummary } from "./providers.ts";
import {
	type Check,
	CORE_CHECKS,
	CORE_PRIVILEGES,
	DEFAULT_TOOL_GROUPS,
	type Delivery,
	type GroupDef,
	GROUPS,
	PAYLOAD_SPEC_DIR,
	parseToolGroups,
	SELECTOR_ENV,
} from "./tool-catalog.ts";
import { defaultPayloadEnv, isPayloadGroup, type PayloadEnv, type PayloadInfo, payloadInfo } from "./tool-payloads.ts";

export const BUILD_INVENTORY_DIR = "/usr/share/t3code/inventory";
export const RUNTIME_STATUS_PATH = "/tmp/t3code-tools/status.json";

/**
 * `pending`: selected, waiting for the background installer. `installing`:
 * the installer is working on it (including retry back-off). `failed`: the
 * last install failed and no usable payload is active. `not-implemented`:
 * selected, but this image has no way to provide the group yet.
 */
export type GroupState = "not-selected" | "pending" | "installing" | "ready" | "failed" | "not-implemented";

export interface CheckResult {
	kind: Check["kind"];
	name: string;
	ok: boolean;
	path: string | null;
}

export interface GroupStatus {
	name: string;
	summary: string;
	selected: boolean;
	state: GroupState;
	delivery: Delivery;
	/** True when every check passes, whatever the state. */
	present: boolean;
	missing: string[];
	packages: readonly string[];
	npm: readonly string[];
	privileges: string;
	checks: CheckResult[];
	/** npm delivery only: desired/active payload ids, installer and last result. */
	payload?: PayloadInfo;
	note?: string;
}

export interface Probe {
	which(command: string): string | null;
	exists(path: string): boolean;
	library(soname: string): string | null;
}

let ldcache: string | undefined;
function findLibrary(soname: string): string | null {
	if (ldcache === undefined) {
		try {
			// Absolute path: library checks must not depend on the caller's PATH,
			// which may omit /usr/sbin. Fall back to PATH outside Debian.
			const ldconfig = ["/usr/sbin/ldconfig", "/sbin/ldconfig"].find((p) => existsSync(p)) ?? "ldconfig";
			const proc = Bun.spawnSync([ldconfig, "-p"], { env: { ...process.env, LC_ALL: "C" } });
			ldcache = proc.exitCode === 0 ? proc.stdout.toString() : "";
		} catch {
			ldcache = "";
		}
	}
	for (const line of ldcache.split("\n")) {
		const match = line.match(/^\s*(\S+) \(.*\) => (\S+)$/);
		if (match?.[1] === soname) return match[2] as string;
	}
	return null;
}

export const systemProbe: Probe = { which: (c) => Bun.which(c), exists: existsSync, library: findLibrary };

function runCheck(check: Check, probe: Probe): CheckResult {
	const path = check.kind === "command" ? probe.which(check.name) : check.kind === "library" ? probe.library(check.name) : probe.exists(check.name) ? check.name : null;
	return { kind: check.kind, name: check.name, ok: path !== null, path };
}

/** State of an npm payload group, from its payload info (never from PATH alone). */
function payloadState(info: PayloadInfo): GroupState {
	if (info.active && info.linked) return "ready";
	if (info.installer && info.last?.state === "installing") return "installing";
	if (info.last?.state === "failed" && (info.last.payloadId === info.desired || info.desired === null)) return "failed";
	return "pending";
}

export function groupStatus(group: GroupDef, selected: boolean, probe: Probe, payload?: PayloadInfo): GroupStatus {
	// Payload groups are checked at their shims (or, for deb, the image's own
	// command of that name), so the result does not depend on the caller's
	// PATH; other groups are probed where the image put them.
	const checks =
		isPayloadGroup(group) && payload
			? group.checks.map((check) => {
					const path =
						check.kind === "command" ? (payload.commandPaths?.[check.name] ?? null) : check.kind === "file" ? (payload.filePaths?.[check.name] ?? null) : null;
					return { kind: check.kind, name: check.name, ok: path !== null && existsSync(path), path };
				})
			: group.checks.map((check) => runCheck(check, probe));
	const missing = checks.filter((check) => !check.ok).map((check) => check.name);
	const present = missing.length === 0;
	let state: GroupState = "not-selected";
	if (selected) state = group.delivery === "none" ? "not-implemented" : payload ? payloadState(payload) : "pending";
	return {
		name: group.name,
		summary: group.summary,
		selected,
		state,
		delivery: group.delivery,
		present,
		missing,
		packages: group.packages,
		npm: group.npm ?? [],
		privileges: group.privileges,
		checks,
		...(payload ? { payload } : {}),
		...(group.note ? { note: group.note } : {}),
	};
}

function readBuildInventory(dir: string) {
	const path = `${dir}/inventory.json`;
	if (!existsSync(path)) return { path: dir, present: false };
	try {
		const inventory = JSON.parse(readFileSync(path, "utf8")) as { architecture?: string; generatedAt?: string; versions?: Record<string, string> };
		return {
			path: dir,
			present: true,
			architecture: inventory.architecture ?? null,
			generatedAt: inventory.generatedAt ?? null,
			t3: inventory.versions?.["t3"] ?? null,
		};
	} catch (error) {
		return { path: dir, present: false, error: String(error) };
	}
}

export function buildStatus(
	raw: string | undefined | null,
	probe: Probe = systemProbe,
	inventoryDir = BUILD_INVENTORY_DIR,
	payloads: PayloadEnv | null = defaultPayloadEnv(PAYLOAD_SPEC_DIR),
	providers: string | undefined | null = process.env[PROVIDERS_ENV],
) {
	const selection = parseToolGroups(raw);
	const core = CORE_CHECKS.map((check) => runCheck(check, probe));
	const coreMissing = core.filter((check) => !check.ok).map((check) => check.name);
	return {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		selector: selection,
		core: { state: coreMissing.length === 0 ? "ready" : "degraded", missing: coreMissing, privileges: CORE_PRIVILEGES, checks: core },
		groups: GROUPS.map((group) =>
			groupStatus(group, selection.selected.includes(group.name), probe, isPayloadGroup(group) && payloads ? payloadInfo(group, payloads) : undefined),
		),
		// Provider CLIs are not groups (T3CODE_PROVIDERS, #13); `t3code-providers status` has the detail.
		providers: buildProviderStatus(providers, probe.which).providers.map(({ token, selected, state, path }) => ({ token, selected, state, path })),
		buildInventory: readBuildInventory(inventoryDir),
		runtimeStatusPath: RUNTIME_STATUS_PATH,
		notes: [
			"npm and deb groups install in the background into the home and are reused across container replacement; not-implemented groups have no installer yet.",
			`Unset or empty ${SELECTOR_ENV} selects the default "${DEFAULT_TOOL_GROUPS}"; "none" is core only. Installing a group grants no privileges (see each group's privileges).`,
			"Provider CLIs are not tool groups: T3CODE_PROVIDERS installs them into the home in the background (issue #13). The providers block is as of generatedAt; t3code-providers status is always live.",
			"A deb group's file checks are paths inside its payload root, reported through the group's current link.",
			"Checks are presence probes (PATH, files, ldconfig), not functional tests or capability grants.",
			"Change the selection with /app/set environment= (see README), never by reapplying the /app YAML.",
		],
	};
}

export type Status = ReturnType<typeof buildStatus>;

export function formatStatus(status: Status): string {
	const lines = [
		`${SELECTOR_ENV}=${status.selector.raw === null ? "(unset)" : JSON.stringify(status.selector.raw)}${status.selector.defaulted ? " (default)" : ""} -> ${status.selector.selected.length ? status.selector.selected.join(" ") : "none (core only)"}`,
		`core: ${status.core.state}${status.core.missing.length ? ` (missing: ${status.core.missing.join(", ")})` : ""}`,
		`providers: ${providerSummary(status.providers)} (t3code-providers status)`,
	];
	for (const group of status.groups) {
		const extra = group.missing.length && group.state !== "not-selected" ? ` missing: ${group.missing.join(", ")}` : "";
		lines.push(`${group.name.padEnd(13)} ${group.state.padEnd(16)}${group.present ? "present" : "absent "}  ${group.summary}${extra}`);
		const p = group.payload;
		if (p && (group.selected || p.installed.length)) {
			const detail = [`payload ${p.active ?? "none"}${p.stale ? ` (refresh to ${p.desired} due)` : ""}`];
			if (!group.selected && p.installed.length) detail.push(`kept on disk: ${p.installed.join(", ")} (t3code-tools prune removes)`);
			if (p.last?.error && group.state !== "ready") detail.push(`last error: ${p.last.error}`);
			if (group.state === "installing" && p.installer?.waitingUntil) detail.push(`retrying at ${p.installer.waitingUntil} (t3code-tools install retries now)`);
			if (p.desiredError) detail.push(p.desiredError);
			lines.push(`${"".padEnd(14)}${detail.join("; ")}`);
		}
	}
	for (const warning of status.selector.warnings) lines.push(`warning: ${warning}`);
	const inv = status.buildInventory;
	lines.push(`build inventory: ${inv.present ? `${inv.path} (${"architecture" in inv ? inv.architecture : "?"})` : `missing at ${inv.path}`}`);
	return `${lines.join("\n")}\n`;
}

/** Write the runtime status JSON atomically; a failure is a warning, never fatal (T3 must start). */
export function writeRuntimeStatus(raw: string | undefined) {
	try {
		const status = buildStatus(raw);
		mkdirSync(dirname(RUNTIME_STATUS_PATH), { recursive: true });
		writeFileSync(`${RUNTIME_STATUS_PATH}.tmp`, `${JSON.stringify(status, null, 2)}\n`);
		renameSync(`${RUNTIME_STATUS_PATH}.tmp`, RUNTIME_STATUS_PATH);
		return status;
	} catch (error) {
		console.error(`t3code-tools: warning: status unavailable: ${String(error)}`);
		return null;
	}
}

