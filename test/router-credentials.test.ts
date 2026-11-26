import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
		`import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const path = args[args.indexOf("--cdb-file") + 1];
if (args[0] === "settings") {
  console.log(JSON.stringify({ data: { value: "custom.cdb" } }));
} else if (args[1] === "init") {
  if (!args.includes("--encrypt") || !args.includes("--cdb-password-file")) process.exit(2);
  writeFileSync(path, "unseeded");
} else if (args[1] === "add") {
  if (process.env.TEST_CENTRS_FAIL) {
    console.error(JSON.stringify({ error: { code: "cdb/password-unavailable", message: "dummy key" } }));
    process.exit(1);
  }
  const password = args.includes("--password-stdin") ? await Bun.stdin.text() : null;
  writeFileSync(path, JSON.stringify({ args, password }));
  if (process.env.TEST_CENTRS_CONCURRENT_CDB) writeFileSync(process.env.TEST_CENTRS_CONCURRENT_CDB, "operator CDB");
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
	const config = join(home, "xdg", "tikoci", "centrs.env");
	mkdirSync(dirname(config), { recursive: true });
	writeFileSync(config, "CENTRS_CDB_FILE=custom.cdb\n");
	expect(initHostCdb({ ...env, XDG_CONFIG_HOME: join(home, "xdg") }, command)).toBe(true);
	expect(existsSync(cdb)).toBe(false);
});

test("a password reaches only the host record via stdin and later starts preserve the CDB", () => {
	const password = join(home, "router-password");
	writeFileSync(password, "dummy router password\n");
	expect(initHostCdb({ ...env, T3APP_ROUTEROS_USER: "router-user", T3APP_ROUTEROS_PASSWORD_FILE: password }, command)).toBe(true);
	const seeded = readFileSync(cdb, "utf8");
	const record = JSON.parse(seeded);
	expect(record.args.slice(0, 5)).toEqual(["devices", "add", "172.18.0.1", "--group", "host"]);
	expect(record.args).toContain("--user=router-user");
	expect(record.args).toContain("--password-stdin");
	expect(record.args).not.toContain("dummy router password");
	expect(record.password).toBe("dummy router password\n");
	writeFileSync(env["CENTRS_CDB_PASSWORD_FILE"] as string, "new key");
	expect(initHostCdb({ ...env, T3APP_ROUTEROS_HOST: "172.18.1.1" }, command)).toBe(true);
	expect(readFileSync(cdb, "utf8")).toBe(seeded);
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

test("the seed preserves a CDB created by another writer during initialization", () => {
	expect(initHostCdb({ ...env, TEST_CENTRS_CONCURRENT_CDB: cdb }, command)).toBe(true);
	expect(readFileSync(cdb, "utf8")).toBe("operator CDB");
	expect(readdirSync(dirname(cdb))).toEqual(["winbox.cdb"]);
});
