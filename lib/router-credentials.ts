import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";

const ROUTER_IP = "T3APP_ROUTEROS_HOST";
const ROUTER_USER = "T3APP_ROUTEROS_USER";
const ROUTER_PASSWORD_FILE = "T3APP_ROUTEROS_PASSWORD_FILE";
const CDB_KEY_FILE = "CENTRS_CDB_PASSWORD_FILE";
const BAKED_CENTRS = ["/usr/local/bin/bun", "--no-env-file", "--no-install", "/opt/bun/bin/centrs"];

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Only create the default CDB on a RouterOS start with a resolved host and a file-based key. */
export function initHostCdb(env: NodeJS.ProcessEnv = process.env, centrs: readonly string[] = BAKED_CENTRS): boolean {
	const home = env["HOME"];
	const host = env[ROUTER_IP];
	const key = env[CDB_KEY_FILE];
	if (!home || !host || !isIP(host)) return true; // The image alone has an unexpanded RouterOS placeholder.

	const cdb = join(home, ".config", "tikoci", "winbox.cdb");
	const config = join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "tikoci", "centrs.env");

	function run(args: readonly string[], stdin: number | "ignore" = "ignore"): Buffer {
		const result = Bun.spawnSync([...centrs, ...args, "--json"], { cwd: home, env, stdin, stderr: "pipe", timeout: 8_000 });
		if (!result.success) {
			// Centrs sends JSON errors to stderr. Copy only the error code to the container log.
			let code: unknown;
			try {
				code = JSON.parse(result.stderr.toString()).error?.code;
			} catch {
				// A timeout or launch failure need not have a centrs envelope.
			}
			const detail = typeof code === "string" && /^[a-z0-9-]+\/[a-z0-9-]+$/.test(code) ? ` (${code})` : "";
			throw new Error(`centrs ${args.slice(0, 2).join(" ")} failed${detail}`);
		}
		return result.stdout;
	}

	try {
		// Existing CDBs, including symlinks and custom locations, belong to the operator.
		if (env["CENTRS_CDB_FILE"] || env["CENTRS_CDB_PASSWORD"] || pathExists(cdb)) return true;
		if (!key || !pathExists(key)) throw new Error(`provide the app key file via ${CDB_KEY_FILE}`);
		if (pathExists(config) && JSON.parse(run(["settings", "get", "CENTRS_CDB_FILE"]).toString()).data?.value) return true;

		const user = env[ROUTER_USER];
		const passwordFile = env[ROUTER_PASSWORD_FILE];
		if ((passwordFile && !user) || (user && user !== "admin" && !passwordFile)) {
			throw new Error(`set ${ROUTER_USER} and ${ROUTER_PASSWORD_FILE} together, or choose admin alone for a lab`);
		}

		mkdirSync(dirname(cdb), { recursive: true, mode: 0o700 });
		const staging = mkdtempSync(join(dirname(cdb), ".t3app-cdb-"));
		try {
			const stagedCdb = join(staging, "winbox.cdb");
			const flags = ["--cdb-file", stagedCdb, "--cdb-password-file", key];
			run(["devices", "init", "--encrypt", ...flags]);
			const add = ["devices", "add", host, "--group", "host", ...flags, ...(user ? [`--user=${user}`] : [])];
			if (passwordFile) {
				const input = openSync(passwordFile, constants.O_RDONLY | constants.O_NONBLOCK);
				try {
					if (!fstatSync(input).isFile()) throw new Error(`${ROUTER_PASSWORD_FILE} must name a regular file`);
					run([...add, "--password-stdin"], input);
				} finally {
					closeSync(input);
				}
			} else {
				run(add);
			}

			// Publish the complete encrypted CDB without replacing a concurrent writer's file.
			try {
				linkSync(stagedCdb, cdb);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		const message = code ? `file operation failed (${code})` : error instanceof Error ? error.message : "initialization failed";
		console.error(`t3app: RouterOS CDB: ${message}`);
		return false;
	}
}
