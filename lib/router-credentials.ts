import { closeSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { kernelFlock, LOCK_EX, LOCK_NB } from "./runtime.ts";

const ROUTER_IP = "T3APP_ROUTEROS_HOST";
const LAB_ADMIN = "T3APP_ROUTEROS_LAB_ADMIN";
const CDB_KEY_FILE = "CENTRS_CDB_PASSWORD_FILE";
const BAKED_CENTRS = ["/usr/local/bin/bun", "--no-env-file", "--no-install", "/opt/bun/bin/centrs"];

function pathInfo(path: string) {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Only create the default CDB on a RouterOS start with a resolved host and a file-based key. */
export function initHostCdb(env: NodeJS.ProcessEnv = process.env, centrs: readonly string[] = BAKED_CENTRS): boolean {
	const home = env["HOME"];
	const host = env[ROUTER_IP];
	const key = env[CDB_KEY_FILE];
	if (!home || !host || !isIP(host)) return true; // The image alone has an unexpanded RouterOS placeholder.

	const dir = join(home, ".config", "tikoci");
	const cdb = join(dir, "winbox.cdb");
	const config = join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "tikoci", "centrs.env");

	function run(args: readonly string[]): Buffer {
		const result = Bun.spawnSync([...centrs, ...args, "--json"], { cwd: home, env, stdin: "ignore", stderr: "pipe", timeout: 8_000 });
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
		// Keep operator-owned locations and value-based keys outside the bootstrap.
		if (env["CENTRS_CDB_FILE"] || env["CENTRS_CDB_PASSWORD"] !== undefined) return true;
		// Centrs settings get reads the file even when ordinary commands skip it.
		const skipConfig = /^(1|true|yes|on)$/i.test(env["CENTRS_SKIP_ENV_FILE"]?.trim() ?? "");
		if (!skipConfig && pathInfo(config) && JSON.parse(run(["settings", "get", "CENTRS_CDB_FILE"]).toString()).data?.value) return true;
		if (!pathInfo(cdb) && (!key || !pathInfo(key))) throw new Error(`provide the app key file via ${CDB_KEY_FILE}`);

		mkdirSync(dir, { recursive: true, mode: 0o700 });
		// Serialize our startup attempts so the next boot can remove abandoned staging directories.
		const lock = openSync(dir, "r");
		try {
			if (!kernelFlock(lock, LOCK_EX | LOCK_NB)) return true;
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.isDirectory() && /^\.t3app-cdb-[a-zA-Z0-9]{6}$/.test(entry.name)) rmSync(join(dir, entry.name), { recursive: true, force: true });
			}

			const existing = pathInfo(cdb);
			if (existing) {
				// Explicitly naming the file keeps centrs list from creating an open CDB if it disappears.
				if (existing.isFile()) run(["devices", "list", "--cdb-file", cdb]);
				return true;
			}
			if (!key) throw new Error(`provide the app key file via ${CDB_KEY_FILE}`);
			const staging = mkdtempSync(join(dir, ".t3app-cdb-"));
			try {
				const stagedCdb = join(staging, "winbox.cdb");
				const flags = ["--cdb-file", stagedCdb, "--cdb-password-file", key];
				run(["devices", "init", "--encrypt", ...flags]);
				run(["devices", "add", host, "--group", "host", ...flags, ...(env[LAB_ADMIN] === "yes" ? ["--user", "admin"] : [])]);
				// Centrs has its own writer lock. The no-replace link lets an existing
				// file win, and centrs detects a changed revision before it publishes.
				try {
					linkSync(stagedCdb, cdb);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
			} finally {
				rmSync(staging, { recursive: true, force: true });
			}
		} finally {
			closeSync(lock);
		}
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		const message = code ? `file operation failed (${code})` : error instanceof Error ? error.message : "initialization failed";
		console.error(`t3app: RouterOS CDB: ${message}`);
		return false;
	}
}
