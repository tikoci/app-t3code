// t3app: the operator command for the app-t3code image (USAGE below). One
// command, grouped by area (`t3app <area> <verb>`): each area is a module
// whose main(argv) this file calls in-process, with no shell strings. New
// areas (inventory, skills #46, credentials #47, triage) join here, not as
// new binaries. AGENTS.md "CLI conventions" has the rules every area follows.
// The image copies lib/ to /usr/local/lib/t3app/ and bin/t3app runs this file.
import { buildProviderStatus, formatProviderStatus, installLogPath as providersLog, PROVIDERS_ENV, main as providersMain } from "./providers.ts";
import { SELECTOR_ENV } from "./tool-catalog.ts";
import { installLogPath as toolsLog, main as toolsMain } from "./tool-groups.ts";
import { defaultRoot } from "./tool-payloads.ts";
import { buildStatus, formatStatus } from "./tool-status.ts";

/**
 * Keys this image read before #45 renamed them, and their new names. A clean
 * break: a set legacy key is never read, only named once in the container
 * log at start (and in `t3app status`), so an operator sees why their
 * selection went back to the defaults.
 */
export const LEGACY_ENV: Readonly<Record<string, string>> = {
	T3CODE_TOOL_GROUPS: "T3APP_TOOL_GROUPS",
	T3CODE_PROVIDERS: "T3APP_PROVIDERS",
	T3CODE_TOOLS_HOME: "T3APP_TOOLS_HOME",
};

export function ignoredLegacyEnv(env: NodeJS.ProcessEnv = process.env): { key: string; replacement: string }[] {
	return Object.entries(LEGACY_ENV)
		.filter(([key]) => env[key] !== undefined)
		.map(([key, replacement]) => ({ key, replacement }));
}

/** The one startup line about ignored legacy keys, or null when none is set. */
export function legacyEnvLine(env: NodeJS.ProcessEnv = process.env): string | null {
	const ignored = ignoredLegacyEnv(env);
	if (ignored.length === 0) return null;
	const pairs = ignored.map(({ key, replacement }) => `${key} (now ${replacement})`).join(", ");
	return `t3app: ignoring ${pairs}; set the new key with /app/set environment= to keep a selection`;
}

export const USAGE = `t3app: the operator command for the app-t3code image

usage: t3app <command> [options]        (no command: status)
       t3app help | --help | <command> --help

Commands
  status [--json]
      Tool groups and provider CLIs in one report: each selection, what is
      ready, installing or failed, and where the installers log. Read-only.
      --json is the form for agents and scripts.
  tools <status|install|prune|groups>
      Optional tool groups (${SELECTOR_ENV}). "t3app tools help" has the details.
  providers <status|install>
      Provider (agent) CLIs (${PROVIDERS_ENV}). "t3app providers help".
  pairing [label]
      Print a one-time browser sign-in link (a token without PUBLIC_URL),
      through T3's "t3 auth pairing create". The label defaults to RouterOS.
  help
      This text.

From RouterOS
  /container/shell app-t3code cmd="t3app status"
  :put [/container/shell app-t3code cmd="t3app pairing" as-value]
  RouterOS drops a command's output after about 60 s, so "tools install" and
  "providers install" start in the background and answer at once; follow
  them with "t3app status". In a terminal, add --wait to run them in place.
  The shell runs as node, the app user. With user=root, tool commands switch
  to node and "providers install" refuses (exit 3).

Settings
  ${SELECTOR_ENV}, ${PROVIDERS_ENV} and T3APP_TOOLS_HOME, set with
  /app/set environment= (never by reapplying the YAML). The T3CODE_* names
  before them are ignored.

Exit codes: 0 ok, 1 the operation failed, 2 usage (unknown command or extra
argument; usage goes to stderr), 3 wrong user.
`;

function usageError(): number {
	process.stderr.write(USAGE);
	return 2;
}

/** `t3app status`: both areas' reports in one, as text or JSON. */
function status(rest: string[]): number {
	if (rest.some((arg) => arg !== "--json")) return usageError();
	const tools = buildStatus(process.env[SELECTOR_ENV]);
	const providers = buildProviderStatus(process.env[PROVIDERS_ENV]);
	const ignoredEnv = ignoredLegacyEnv();
	const logs = { tools: toolsLog(), toolPayloads: `${defaultRoot()}/install.log`, providers: providersLog() };
	if (rest.includes("--json")) {
		process.stdout.write(`${JSON.stringify({ schemaVersion: 1, generatedAt: tools.generatedAt, tools, providers, ignoredEnv, logs }, null, 2)}\n`);
		return 0;
	}
	const legacy = legacyEnvLine();
	process.stdout.write(
		[
			"== tools (t3app tools help)",
			formatStatus(tools).trimEnd(),
			"",
			"== providers (t3app providers help)",
			formatProviderStatus(providers).trimEnd(),
			"",
			`logs: ${logs.tools}, ${logs.providers}; payload installs: ${logs.toolPayloads}`,
			...(legacy ? [legacy] : []),
			"",
		].join("\n"),
	);
	return 0;
}

/** `t3app pairing [label]`: upstream's pairing command, with this image's defaults. */
function pairing(rest: string[]): number {
	if (rest.length > 1 || rest[0]?.startsWith("-")) return usageError();
	const label = rest[0] ?? "RouterOS";
	const publicUrl = process.env["PUBLIC_URL"];
	const argv = ["t3", "auth", "pairing", "create", "--label", label, ...(publicUrl ? ["--base-url", publicUrl] : [])];
	try {
		const proc = Bun.spawnSync(argv, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
		return proc.exitCode === 0 ? 0 : 1;
	} catch (error) {
		process.stderr.write(`t3app pairing: cannot run t3: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

/**
 * Internal (the entrypoint): name ignored legacy keys, then each area's
 * startup hook. Bounded and never fatal, because T3 must start; providers
 * first, since its hook is the fast one.
 */
async function init(rest: string[]): Promise<number> {
	if (rest.length > 0) return usageError();
	const legacy = legacyEnvLine();
	if (legacy) console.error(legacy);
	await providersMain(["init"]);
	await toolsMain(["init"]);
	return 0;
}

/** The t3app CLI; returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
	const [command = "status", ...rest] = argv;
	if (command === "help" || command === "-h" || command === "--help") {
		if (rest.length > 0) return usageError();
		process.stdout.write(USAGE);
		return 0;
	}
	if (command === "tools") return toolsMain(rest);
	if (command === "providers") return providersMain(rest);
	if (rest.includes("--help") || rest.includes("-h")) {
		if (!["status", "pairing", "init"].includes(command)) return usageError();
		process.stdout.write(USAGE);
		return 0;
	}
	if (command === "status") return status(rest);
	if (command === "pairing") return pairing(rest);
	if (command === "init") return init(rest);
	return usageError();
}

/**
 * RouterOS runs /container/shell commands with umask 0000 (measured on 7.25),
 * bypassing the entrypoint's 022, so anything t3app writes in /data, or
 * starts in the background, would be world-writable. Same umask as the server.
 */
export const UMASK = 0o022;

if (import.meta.main) {
	process.umask(UMASK);
	process.exit(await main(process.argv.slice(2)));
}
