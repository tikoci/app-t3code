import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initHostCdb } from "../lib/router-credentials.ts";

let home: string;
let cdb: string;
let env: NodeJS.ProcessEnv;
let command: string[];

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "t3app-centrs-"));
	cdb = join(home, ".config", "tikoci", "winbox.cdb");
	const key = join(home, "key");
	writeFileSync(key, "dummy key\n");
	env = { HOME: home, T3APP_ROUTEROS_HOST: "172.18.0.1", CENTRS_CDB_PASSWORD_FILE: key };
	const cli = join(home, "centrs.ts");
	writeFileSync(
		cli,
		`import { existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const path = args[args.indexOf("--cdb-file") + 1];
function fail(code) {
  console.error(JSON.stringify({ error: { code, message: "dummy key" } }));
  process.exit(1);
}
if (args[0] === "settings") {
  console.log(JSON.stringify({ data: { value: process.env.TEST_CENTRS_CONFIG_CDB ?? null } }));
} else if (args[1] === "init") {
  if (!args.includes("--encrypt") || !args.includes("--cdb-password-file")) process.exit(2);
  writeFileSync(path, "unseeded");
} else if (args[1] === "add") {
  if (process.env.TEST_CENTRS_FAIL) fail("cdb/password-unavailable");
  writeFileSync(path, JSON.stringify(args));
  if (process.env.TEST_CENTRS_CONCURRENT_CDB) writeFileSync(process.env.TEST_CENTRS_CONCURRENT_CDB, "operator CDB");
} else if (args[1] === "list") {
  if (!existsSync(process.env.CENTRS_CDB_PASSWORD_FILE)) fail("cdb/password-unavailable");
  if (process.env.TEST_CENTRS_WRONG_KEY) fail("cdb/decrypt-failed");
} else {
  process.exit(2);
}
`,
	);
	command = [process.execPath, "--no-env-file", cli];
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

test("standalone containers and user-owned CDB locations are skipped", () => {
	expect(initHostCdb({ ...env, T3APP_ROUTEROS_HOST: "[networkRouterIP]" }, command)).toBe(true);
	expect(initHostCdb({ ...env, CENTRS_CDB_FILE: join(home, "custom.cdb") }, command)).toBe(true);
	expect(initHostCdb({ ...env, CENTRS_CDB_PASSWORD: "" }, command)).toBe(true);
	const config = join(home, "xdg", "tikoci", "centrs.env");
	mkdirSync(dirname(config), { recursive: true });
	writeFileSync(config, "CENTRS_CDB_FILE=custom.cdb\n");
	expect(
		initHostCdb({ ...env, XDG_CONFIG_HOME: join(home, "xdg"), TEST_CENTRS_CONFIG_CDB: "custom.cdb", CENTRS_CDB_PASSWORD_FILE: "" }, command),
	).toBe(true);
	expect(existsSync(cdb)).toBe(false);
	writeFileSync(config, "CENTRS_PORT=80\n");
	expect(initHostCdb({ ...env, XDG_CONFIG_HOME: join(home, "xdg") }, command)).toBe(true);
	expect(existsSync(cdb)).toBe(true);
});

test("the bootstrap uses only the host record and adds admin only for an opted-in lab", () => {
	expect(initHostCdb(env, command)).toBe(true);
	const seeded = readFileSync(cdb, "utf8");
	const args = JSON.parse(seeded);
	expect(args.slice(0, 5)).toEqual(["devices", "add", "172.18.0.1", "--group", "host"]);
	expect(args).not.toContain("--user");
	expect(args).not.toContain("__default__");
	expect(initHostCdb({ ...env, T3APP_ROUTEROS_HOST: "172.18.1.1", T3APP_ROUTEROS_LAB_ADMIN: "yes" }, command)).toBe(true);
	expect(readFileSync(cdb, "utf8")).toBe(seeded);
	rmSync(cdb);
	expect(initHostCdb({ ...env, T3APP_ROUTEROS_LAB_ADMIN: "yes" }, command)).toBe(true);
	expect(JSON.parse(readFileSync(cdb, "utf8"))).toContain("admin");
});

test("a failed seed leaves no partial CDB and the next start can retry", () => {
	const log = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(initHostCdb({ ...env, TEST_CENTRS_FAIL: "yes" }, command)).toBe(false);
		expect(readdirSync(dirname(cdb))).toEqual([]);
		expect(log).toHaveBeenCalledWith("t3app: RouterOS CDB: centrs devices add failed (cdb/password-unavailable)");
	} finally {
		log.mockRestore();
	}
	expect(initHostCdb(env, command)).toBe(true);
	expect(existsSync(cdb)).toBe(true);
});

test("a missing key blocks seeding and a lost or wrong key leaves an existing CDB intact", () => {
	const log = spyOn(console, "error").mockImplementation(() => {});
	const missing = { ...env, CENTRS_CDB_PASSWORD_FILE: join(home, "missing") };
	try {
		expect(initHostCdb(missing, command)).toBe(false);
		expect(log).toHaveBeenCalledWith("t3app: RouterOS CDB: provide the app key file via CENTRS_CDB_PASSWORD_FILE");
		expect(existsSync(cdb)).toBe(false);
		expect(initHostCdb(env, command)).toBe(true);
		const before = readFileSync(cdb, "utf8");
		expect(initHostCdb(missing, command)).toBe(false);
		expect(log).toHaveBeenCalledWith("t3app: RouterOS CDB: centrs devices list failed (cdb/password-unavailable)");
		expect(initHostCdb({ ...env, TEST_CENTRS_WRONG_KEY: "yes" }, command)).toBe(false);
		expect(log).toHaveBeenCalledWith("t3app: RouterOS CDB: centrs devices list failed (cdb/decrypt-failed)");
		expect(readFileSync(cdb, "utf8")).toBe(before);
	} finally {
		log.mockRestore();
	}
});

test("a later start clears abandoned staging and preserves a dangling CDB link", () => {
	const abandoned = join(dirname(cdb), ".t3app-cdb-ABC123");
	mkdirSync(abandoned, { recursive: true });
	writeFileSync(join(abandoned, "winbox.cdb"), "abandoned");
	symlinkSync(join(home, "missing.cdb"), cdb);
	expect(initHostCdb(env, command)).toBe(true);
	expect(lstatSync(cdb).isSymbolicLink()).toBe(true);
	expect(existsSync(abandoned)).toBe(false);
});

test("the seed preserves a CDB created by another writer during initialization", () => {
	expect(initHostCdb({ ...env, TEST_CENTRS_CONCURRENT_CDB: cdb }, command)).toBe(true);
	expect(readFileSync(cdb, "utf8")).toBe("operator CDB");
	expect(readdirSync(dirname(cdb))).toEqual(["winbox.cdb"]);
});
