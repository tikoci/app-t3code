/** Real image replacement proof; run with APP_T3CODE_DOCKER_IMAGE=<local tag>. */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const image = process.env["APP_T3CODE_DOCKER_IMAGE"];
const expectedVersion = process.env["APP_T3CODE_T3VER"] ??
	(await Bun.file(new URL("../package.json", import.meta.url)).json()).version;

/** Run Docker, returning stdout and reporting its output if the command fails. */
async function docker(...args: string[]): Promise<string> {
	const proc = Bun.spawn(["docker", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0)
		throw new Error(`docker ${args[0]} exited ${code}: ${err}\n${out}`);
	return out.trim();
}

test.skipIf(!image)("the baked Centrs bootstraps and preserves the encrypted host CDB", async () => {
	const volume = `app-t3code-centrs-${randomUUID()}`;
	const fixtures = mkdtempSync(join(tmpdir(), "app-t3code-centrs-"));
	chmodSync(fixtures, 0o755); // The container reads these dummy files as node.
	const key = join(fixtures, "t3code_cdb_key");
	const account = join(fixtures, "fixture-account");
	writeFileSync(account, "fixture router password\n", { mode: 0o644 });
	const env = [
		"--env", "T3APP_TOOL_GROUPS=none", "--env", "T3APP_PROVIDERS=none", "--env", "T3APP_SKILLS=none",
		"--env", "T3APP_ROUTEROS_HOST=192.0.2.41", "--env", "T3APP_ROUTEROS_LAB_ADMIN=yes",
	];
	const mount = ["--mount", `type=bind,src=${fixtures},dst=/run/secrets,readonly`];
	const cdb = "/data/.config/tikoci/winbox.cdb";
	const start = (script: string) =>
		docker("run", "--rm", "--network", "none", "--volume", `${volume}:/data`, ...env, ...mount, image as string, "bash", "-o", "pipefail", "-ec", script);
	const checkKey = async (code: string) => {
		const result = await start(`if centrs devices list --json 2>/tmp/centrs-error; then exit 1; fi
jq -e '.error.code == "${code}"' /tmp/centrs-error
if t3app init >/dev/null 2>/tmp/init-error; then exit 1; fi
grep -F "centrs devices list failed (${code})" /tmp/init-error
sha256sum ${cdb}`);
		return result.split("\n").at(-1);
	};
	try {
		writeFileSync(key, "fixture CDB key\n", { mode: 0o644 });
		await docker("volume", "create", volume);
		await docker("run", "--rm", "--network", "none", "--user", "root", ...env, ...mount, image as string, "test", "!", "-e", cdb);
		const first = await start(`centrs --version
test "$(stat -c %a ${cdb})" = 600
centrs devices list --json | jq -e '.data | length == 1 and .[0].target == "192.0.2.41" and .[0].group == "host" and .[0].user == "admin"'
centrs devices set 192.0.2.41 --user t3-agent --password-stdin < /run/secrets/fixture-account >/dev/null
sha256sum ${cdb}`);
		console.log(`Centrs image smoke: ${first.split("\n").find((line) => /^\d+\.\d+\.\d+/.test(line))}`);
		const fingerprint = first.split("\n").at(-1);
		writeFileSync(key, "changed fixture key\n");
		expect(await checkKey("cdb/decrypt-failed")).toBe(fingerprint);
		rmSync(key);
		expect(await checkKey("cdb/password-unavailable")).toBe(fingerprint);
		writeFileSync(key, "fixture CDB key\n", { mode: 0o644 });
		const restored = await start(`centrs devices list --json | jq -e '.data | length == 1 and .[0].user == "t3-agent"'
sha256sum ${cdb}`);
		expect(restored.split("\n").at(-1)).toBe(fingerprint);
	} finally {
		await docker("volume", "rm", volume).catch(() => {});
		rmSync(fixtures, { recursive: true, force: true });
	}
}, 120_000);

/** Wait up to two minutes for the expected server version, including logs on timeout. */
async function waitForServer(name: string): Promise<void> {
	const address = await docker("port", name, "3773/tcp");
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const response = await fetch(`http://${address}/.well-known/t3/environment`, {
			signal: AbortSignal.timeout(2000),
		}).catch(() => undefined);
		if (response?.ok) {
			const body = (await response.json()) as { serverVersion?: string };
			expect(body.serverVersion).toBe(expectedVersion);
			return;
		}
		await Bun.sleep(1000);
	}
	throw new Error(`Server did not start:\n${await docker("logs", name)}`);
}

/** Read effective server preferences through MCP with a temporary read-only credential. */
async function readEnvironment(name: string) {
	const address = await docker("port", name, "3773/tcp");
	const credential = JSON.parse(await docker(
		"exec", name, "t3", "auth", "session", "issue",
		"--subject", "mcp-client", "--scope", "orchestration:read",
		"--ttl", "5m", "--json",
	)) as { sessionId: string; token: string };
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		Authorization: `Bearer ${credential.token}`,
	};
	const post = (body: object) => fetch(`http://${address}/mcp`, {
		method: "POST", headers, body: JSON.stringify(body),
		signal: AbortSignal.timeout(10_000),
	});
	try {
		const initialized = await post({
			jsonrpc: "2.0", id: 1, method: "initialize",
			params: {
				protocolVersion: "2025-06-18", capabilities: {},
				clientInfo: { name: "container-replacement-test", version: "1.0.0" },
			},
		});
		expect(initialized.status).toBe(200);
		await initialized.arrayBuffer();
		const sessionId = initialized.headers.get("mcp-session-id");
		expect(sessionId).toBeString();
		headers["Mcp-Session-Id"] = sessionId as string;
		headers["Mcp-Protocol-Version"] = "2025-06-18";
		const notification = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
		expect(notification.status).toBe(202);
		await notification.arrayBuffer();
		const response = await post({
			jsonrpc: "2.0", id: 2, method: "tools/call",
			params: { name: "t3_environment_read", arguments: {} },
		});
		expect(response.status).toBe(200);
		const body = await response.json() as {
			error?: unknown;
			result?: {
				isError?: boolean;
				structuredContent?: {
					environmentId: string;
					preferences: { enableProviderUpdateChecks: boolean };
				};
			};
		};
		expect(body.error).toBeUndefined();
		expect(body.result?.isError).not.toBe(true);
		const environment = body.result?.structuredContent;
		if (!environment) throw new Error("MCP environment read returned no structured result");
		return environment;
	} finally {
		await docker("exec", name, "t3", "auth", "session", "revoke", credential.sessionId);
	}
}

test.skipIf(!image)(
	"agents find the baked tools and T3 projects/settings survive container replacement",
	async () => {
		const name = `app-t3code-replacement-${randomUUID()}`;
		const volume = `${name}-data`;
		const run = (...args: string[]) => docker("exec", name, ...args);
		// No other --env: like a RouterOS env-list replacement that drops the
		// YAML defaults, so the image ENV defaults must carry correct operation.
		// Every start sets its selection explicitly, except `null`, which checks
		// the image's own group default. Every start pins providers to Codex (a
		// real npm install into the home, #13), so the test never downloads Claude.
		// Skills keep the image default (one anonymous GitHub fetch, #46).
		let startedAt = 0;
		const start = (groups: string | null, offline = false, extraEnv: string[] = []) => {
			startedAt = Date.now() - 1000;
			return docker(
				"run",
				"--detach",
				"--name",
				name,
				...(offline ? ["--network", "none"] : ["--publish", "127.0.0.1::3773"]),
				"--volume",
				`${volume}:/data`,
				...(groups === null ? [] : ["--env", `T3APP_TOOL_GROUPS=${groups}`]),
				"--env",
				"T3APP_PROVIDERS=codex",
				...extraEnv.flatMap((pair) => ["--env", pair]),
				image as string,
			);
		};
		/** The agent-facing status (live) and the runtime JSON the entrypoint wrote. */
		const toolStatus = async () => {
			type Status = {
				selector: { raw: string | null; defaulted: boolean; selected: string[]; unknown: string[]; warnings: string[] };
				core: { state: string; missing: string[] };
				groups: {
					name: string;
					selected: boolean;
					state: string;
					payload?: {
						active: string | null;
						installed: string[];
						activeVersions: Record<string, string> | null;
						last: { state: string; updatedAt: string; error?: string } | null;
					};
				}[];
				buildInventory: { present: boolean };
			};
			const live = JSON.parse(await run("t3app", "tools", "status", "--json")) as Status;
			const written = JSON.parse(await run("cat", "/tmp/t3code-tools/status.json")) as Status;
			expect(written.selector).toEqual(live.selector);
			return live;
		};
		/**
		 * Wait for the background installer to settle a payload group, in both
		 * the live status and the runtime JSON the installer rewrites. Until the
		 * entrypoint has written that file (a fresh container), keep polling.
		 */
		const settled = async (group: string, timeoutMs: number) => {
			const deadline = Date.now() + timeoutMs;
			let last = "no status yet";
			for (;;) {
				try {
					const status = await toolStatus();
					const written = JSON.parse(await run("cat", "/tmp/t3code-tools/status.json")) as Awaited<ReturnType<typeof toolStatus>>;
					const found = status.groups.find((g) => g.name === group);
					const persisted = written.groups.find((g) => g.name === group);
					last = `live ${found?.state}, written ${persisted?.state}`;
					if (found && !["pending", "installing"].includes(found.state) && persisted?.state === found.state && persisted.payload?.active === found.payload?.active) {
						return { status, group: found };
					}
				} catch (error) {
					last = String(error);
				}
				if (Date.now() > deadline) throw new Error(`${group} not settled (${last}):\n${await run("cat", "/data/.local/share/t3code-tools/install.log").catch(() => "")}`);
				await Bun.sleep(2000);
			}
		};
		/** Wait for this container's first skills run (#46) to finish a pass: done, or waiting to retry. */
		type Skills = {
			selector: { raw: string | null };
			installer: { waitingUntil?: string } | null;
			lastRun: { at: string } | null;
			tokens: { token: string; state: string; commit: string | null; error?: string }[];
			skills: { name: string; state: string }[];
		};
		const skillsSettled = async (timeoutMs: number) => {
			const since = new Date(startedAt).toISOString();
			const deadline = Date.now() + timeoutMs;
			let last = "no status yet";
			for (;;) {
				try {
					const status = JSON.parse(await run("t3app", "skills", "status", "--json")) as Skills;
					last = JSON.stringify({ lastRun: status.lastRun, installer: status.installer, tokens: status.tokens });
					if (status.lastRun && status.lastRun.at >= since && (!status.installer || status.installer.waitingUntil)) return status;
				} catch (error) {
					last = String(error);
				}
				if (Date.now() > deadline) throw new Error(`skills not settled (${last}):\n${await run("cat", "/data/.local/state/t3code/skills.log").catch(() => "")}`);
				await Bun.sleep(2000);
			}
		};
		const devTools = "cd /tmp; tsc --version; biome --version; cspell --version; markdownlint-cli2 --version";
		// A deb payload's functional script, as node with no capabilities
		// (test/capture-tools.sh, vpn-tools.sh, routing-tools.sh, labs-tools.sh).
		// Against an emulated (QEMU user-mode) image, set CAPTURE_TOOLS_QEMU_USER,
		// ROUTING_TOOLS_QEMU_USER and/or LABS_TOOLS_QEMU_USER for this test: they
		// are forwarded so the scripts skip only checks that emulation breaks (or
		// makes too slow) before any permission check. Native runs keep every check.
		const qemuFlags = ["CAPTURE_TOOLS_QEMU_USER", "ROUTING_TOOLS_QEMU_USER", "LABS_TOOLS_QEMU_USER"].filter((key) => process.env[key]).map((key) => `${key}=1 `).join("");
		const groupTools = async (group: string, shell: string) => {
			await docker("cp", new URL(`./${group}-tools.sh`, import.meta.url).pathname, `${name}:/tmp/${group}-tools.sh`);
			return run("bash", shell, `${qemuFlags}bash /tmp/${group}-tools.sh`);
		};
		const captureTools = (shell: string) => groupTools("capture", shell);
		const nativeOk = { capture: "capture ok: TShark (Wireshark) ", labs: "labs ok: QEMU emulator version ", vpn: "vpn ok: wireguard-tools ", routing: "routing ok: BIRD version " };
		await docker("volume", "create", volume);
		try {
			// CI exercises every group so the reported states cover the full set.
			await start("all");
			await waitForServer(name);
			expect(await run("printenv", "T3CODE_TELEMETRY_ENABLED")).toBe("false");
			// T3 is already serving; the dev, capture, labs, vpn and routing
			// payloads install in the background, one after the other.
			const { group: devFirst } = await settled("dev", 180_000);
			expect(devFirst.payload?.last?.error).toBeUndefined();
			expect(devFirst.payload?.activeVersions?.["tsc"]).toStartWith("Version ");
			const { group: captureFirst } = await settled("capture", 300_000);
			expect(captureFirst.payload?.last?.error).toBeUndefined();
			expect(captureFirst.payload?.activeVersions?.["tshark"]).toStartWith("TShark (Wireshark) ");
			expect(captureFirst.payload?.active).toMatch(/^(amd64|arm64)-trixie-[0-9a-f]{16}$/);
			// QEMU is not in the image any more: it comes from the labs payload.
			const { group: labsFirst } = await settled("labs", 300_000);
			expect(labsFirst.payload?.last?.error).toBeUndefined();
			expect(labsFirst.payload?.activeVersions?.["qemu-system-aarch64"]).toStartWith("QEMU emulator version ");
			expect(labsFirst.payload?.activeVersions?.["quickchr"]).toStartWith("quickchr ");
			const { group: vpnFirst } = await settled("vpn", 180_000);
			expect(vpnFirst.payload?.last?.error).toBeUndefined();
			expect(vpnFirst.payload?.activeVersions?.["pki"]).toStartWith("strongSwan ");
			const { status: all, group: routingFirst } = await settled("routing", 180_000);
			expect(routingFirst.payload?.last?.error).toBeUndefined();
			expect(routingFirst.payload?.activeVersions?.["bird"]).toStartWith("BIRD version ");
			expect(all.core).toMatchObject({ state: "ready", missing: [] });
			expect(all.buildInventory.present).toBe(true);
			expect(all.selector.warnings).toEqual([]);
			expect(all.groups.every((group) => group.selected)).toBe(true);
			expect(Object.fromEntries(all.groups.map((group) => [group.name, group.state]))).toEqual({
				capture: "ready",
				labs: "ready",
				vpn: "ready",
				routing: "ready",
				dev: "ready",
			});
			// No provider CLI is baked (#13): Codex installs into the home in the background.
			type Providers = { providers: { token: string; state: string; path: string | null; last: { error?: string } | null }[] };
			const codexReady = async (timeoutMs: number) => {
				const deadline = Date.now() + timeoutMs;
				for (;;) {
					const codex = (JSON.parse(await run("t3app", "providers", "status", "--json")) as Providers).providers.find((p) => p.token === "codex");
					if (codex?.state === "ready" || Date.now() > deadline) return codex;
					await Bun.sleep(2000);
				}
			};
			expect(await codexReady(300_000)).toMatchObject({ state: "ready", path: "/data/.local/bin/codex" });
			expect(await run("cat", "/data/.local/state/t3code/providers.log")).toContain("codex: ready");
			expect(await run("realpath", "/data/.local/bin/codex")).toStartWith("/data/.local/lib/node_modules/@openai/codex/");
			expect(Bun.spawnSync(["docker", "exec", name, "bash", "-lc", "command -v muse"]).exitCode).not.toBe(0);
			// Skills (#46): the image default imports tikoci/routeros-skills from
			// GitHub (anonymous, one repository) into the home in the background.
			const skillsFirst = await skillsSettled(180_000);
			expect(skillsFirst.selector.raw).toBe("tikoci/routeros-skills");
			expect(skillsFirst.tokens).toEqual([expect.objectContaining({ token: "tikoci/routeros-skills", state: "resolved", commit: expect.stringMatching(/^[0-9a-f]{40}$/) })]);
			expect(skillsFirst.skills.length).toBeGreaterThan(0);
			expect(skillsFirst.skills.filter((s) => s.state !== "installed")).toEqual([]);
			const skill = skillsFirst.skills.find((s) => s.name === "routeros-fundamentals")?.name ?? (skillsFirst.skills[0]?.name as string);
			expect(await run("readlink", `/data/.claude/skills/${skill}`)).toBe(`../../.agents/skills/${skill}`);
			expect(await run("stat", "-c", "%U %a", `/data/.agents/skills/${skill}`)).toBe("node 755");
			expect(await run("head", "-1", `/data/.claude/skills/${skill}/SKILL.md`)).toBe("---");
			expect(JSON.parse(await run("cat", "/data/.agents/.skill-lock.json")).skills[skill]).toMatchObject({ source: "tikoci/routeros-skills" });
			expect(Bun.spawnSync(["docker", "exec", "-u", "0", name, "t3app", "skills", "update"]).exitCode).toBe(3);
			for (const shell of ["-c", "-lc"]) {
				const shellStatus = JSON.parse(await run("bash", shell, "t3app tools status --json"));
				expect(shellStatus.core).toMatchObject({ state: "ready", missing: [] });
				await run(
					"bash",
					shell,
					`set -e; bun --version; bunx --version; quickchr --help; centrs explain '/ip/address print' --json; uv --version; uvx --version; sqlite3 --version; zstd --version; gh --version; codex --version; qemu-system-x86_64 --version; qemu-system-aarch64 --version; qemu-img --version; ${devTools}`,
				);
				for (const [group, ok] of Object.entries(nativeOk)) expect(await groupTools(group, shell)).toContain(ok);
			}
			// t3app (#45): one status for both areas; argument errors run nothing.
			const combined = JSON.parse(await run("t3app", "status", "--json"));
			expect(combined.tools.selector.selected).toEqual(all.selector.selected);
			expect(combined.skills.tokens[0]).toMatchObject({ state: "resolved" });
			expect(combined.providers.providers.find((p: { token: string }) => p.token === "codex")).toMatchObject({ state: "ready" });
			expect(combined.ignoredEnv).toEqual([]);
			expect(Bun.spawnSync(["docker", "exec", name, "t3app", "tools", "install", "now"]).exitCode).toBe(2);
			// Root (`/container/shell user=root`): tool commands switch to node, so
			// nothing in the home becomes root-owned; providers install refuses.
			expect(Bun.spawnSync(["docker", "exec", "-u", "0", name, "t3app", "providers", "install"]).exitCode).toBe(3);
			await docker("exec", "-u", "0", name, "t3app", "tools", "prune");
			// A long verb answers at once and leaves the work in the background.
			const asked = Date.now();
			const started = await docker("exec", "-u", "0", name, "t3app", "tools", "install");
			expect(started).toContain("started in the background");
			expect(Date.now() - asked).toBeLessThan(15_000);
			// Wait for that run itself (its pid), not the advisory installer record.
			const pid = /\(pid (\d+)\)/.exec(started)?.[1] as string;
			const gone = Date.now() + 60_000;
			while (Bun.spawnSync(["docker", "exec", name, "test", "-d", `/proc/${pid}`]).exitCode === 0) {
				if (Date.now() > gone) throw new Error(`background tools install (pid ${pid}) still running after 60 s`);
				await Bun.sleep(1000);
			}
			expect(await run("cat", "/data/.local/state/t3code/tool-groups.log")).toContain("t3app: tools install started in the background");
			expect(await docker("exec", "-u", "0", name, "find", "/data/.local/share/t3code-tools", "/data/.local/state/t3code", "-uid", "0")).toBe("");
			await run(
				"bash",
				"-ec",
				`
mkdir -p /data/projects/survivor /data/.t3/projects/managed /data/.t3/scratch/survivor /data/.config/muse /data/.config/gh
cd /data/projects/survivor
git init -b main
git -c user.name=Test -c user.email=test@example.invalid commit --allow-empty -m initial
git worktree add /data/.t3/worktrees/survivor -b survivor
printf 'image layer' > /tmp/replacement-fixture
printf 'project edit' > README.md
printf 'worktree edit' > /data/.t3/worktrees/survivor/edit.txt
printf 'managed project' > /data/.t3/projects/managed/README.md
printf 'scratch edit' > /data/.t3/scratch/survivor/edit.txt
printf 'synthetic credential fixture' > /data/.config/muse/persistence-fixture
# A file-backed gh login (no keyring in the container) in gh's default config dir.
printf 'version: "1"\\n' > /data/.config/gh/config.yml
printf 'github.com:\\n    users:\\n        persistence-fixture:\\n            oauth_token: gho_synthetic_persistence_fixture\\n    git_protocol: https\\n    user: persistence-fixture\\n    oauth_token: gho_synthetic_persistence_fixture\\n' > /data/.config/gh/hosts.yml
# A user-installed Muse in the home must survive replacement and win on PATH.
mkdir -p /data/.local/bin
printf '#!/bin/sh\\necho user-installed-muse' > /data/.local/bin/muse
chmod +x /data/.local/bin/muse
# A uv project environment on the image's Python, with the sqlite3 module.
UV_NO_CACHE=1 uv venv --quiet /data/projects/survivor/.venv
mkdir -p /data/.bun/tool-fixture
printf '{"name":"persistence-tool-fixture","version":"1.0.0","bin":{"persistence-tool-fixture":"cli.sh"}}' > /data/.bun/tool-fixture/package.json
printf '#!/bin/sh\\nprintf persistent-bun-tool' > /data/.bun/tool-fixture/cli.sh
chmod +x /data/.bun/tool-fixture/cli.sh
bun install --global /data/.bun/tool-fixture
t3 project add /data/projects/survivor --title 'Survivor'
`,
			);
			const project = await run(
				"t3",
				"project",
				"rename",
				"/data/projects/survivor",
				"Survivor",
			);
			expect(project).toContain("is already named Survivor");
			// `gh auth token` reads the stored login without a network call.
			expect(await run("gh", "auth", "token", "--hostname", "github.com")).toBe("gho_synthetic_persistence_fixture");
			const identity = await run("cat", "/data/.t3/userdata/environment-id");
			expect(identity.length).toBeGreaterThan(0);
			// RouterOS SIGKILLs a container at once unless PID 1 has a TERM
			// handler: SigCgt bit 14 (signal 15) in /proc/1/status (#25).
			const sigCgt = (await run("grep", "SigCgt", "/proc/1/status")).split(/\s+/)[1] ?? "0";
			expect(BigInt(`0x${sigCgt}`) & (1n << 14n)).toBe(1n << 14n);
			// Stop before editing settings to avoid racing the live server's writer.
			// T3 stops on the forwarded TERM (about 5 s on a CHR) within RouterOS's
			// stop-time of 30 s, and exits 130, its status after a signal-driven
			// shutdown (anchor: a T3 release that changes it updates this). A
			// SIGKILL after the timeout would be 137.
			await docker("stop", "--time", "30", name);
			expect(await docker("inspect", "--format", "{{.State.ExitCode}}", name)).toBe("130");
			await docker("rm", name);
			await docker(
				"run",
				"--rm",
				"--volume",
				`${volume}:/data`,
				"--entrypoint",
				"bun",
				image as string,
				"-e",
				'const file = Bun.file("/data/.t3/userdata/settings.json"); const settings = await file.exists() ? await file.json() : {}; settings.enableProviderUpdateChecks = false; await Bun.write(file, JSON.stringify(settings));',
			);

			// A new writable layer and container id, with only the same named home
			// volume. An unknown group is a warning: T3 must still start.
			// A legacy key from before #45 is ignored, and named in the log.
			await start("capture+bogus labs", false, ["T3CODE_TOOL_GROUPS=dev"]);
			await waitForServer(name);
			const partial = await toolStatus();
			expect(partial.selector.selected).toEqual(["capture", "labs"]);
			// labs relinked at start from the home, like capture: nothing reinstalled.
			const labsAgain = partial.groups.find((group) => group.name === "labs");
			expect(labsAgain?.state).toBe("ready");
			expect(labsAgain?.payload?.active).toBe(labsFirst.payload?.active as string);
			expect(labsAgain?.payload?.last?.updatedAt).toBe(labsFirst.payload?.last?.updatedAt as string);
			expect(partial.selector.unknown).toEqual(["bogus"]);
			expect(partial.groups.find((group) => group.name === "vpn")?.state).toBe("not-selected");
			// Deselected: shims gone, payload kept for a later reselection.
			const devOff = partial.groups.find((group) => group.name === "dev");
			expect(devOff?.state).toBe("not-selected");
			expect(devOff?.payload?.installed).toEqual([devFirst.payload?.active as string]);
			expect(Bun.spawnSync(["docker", "exec", name, "bash", "-lc", "command -v tsc"]).exitCode).not.toBe(0);
			// Reselected in a new container: relinked at start, nothing downloaded again.
			const captureAgain = partial.groups.find((group) => group.name === "capture");
			expect(captureAgain?.state).toBe("ready");
			expect(captureAgain?.payload?.active).toBe(captureFirst.payload?.active as string);
			expect(captureAgain?.payload?.last?.updatedAt).toBe(captureFirst.payload?.last?.updatedAt as string);
			await captureTools("-lc");
			const logs = Bun.spawnSync(["docker", "logs", name]);
			expect(`${logs.stdout}${logs.stderr}`).toContain('unknown group "bogus" ignored');
			expect(`${logs.stdout}${logs.stderr}`).toContain("t3app: ignoring T3CODE_TOOL_GROUPS (now T3APP_TOOL_GROUPS)");
			expect(JSON.parse(await run("t3app", "status", "--json")).ignoredEnv).toEqual([{ key: "T3CODE_TOOL_GROUPS", replacement: "T3APP_TOOL_GROUPS" }]);
			await run("test", "!", "-e", "/tmp/replacement-fixture");
			expect(
				await run(
					"t3",
					"project",
					"rename",
					"/data/projects/survivor",
					"Survivor",
				),
			).toBe(project);
			expect(await run("cat", "/data/.t3/userdata/environment-id")).toBe(
				identity,
			);
			expect(await run("cat", "/data/projects/survivor/README.md")).toBe(
				"project edit",
			);
			expect(await run("cat", "/data/.t3/worktrees/survivor/edit.txt")).toBe(
				"worktree edit",
			);
			expect(await run("cat", "/data/.t3/projects/managed/README.md")).toBe(
				"managed project",
			);
			expect(await run("cat", "/data/.t3/scratch/survivor/edit.txt")).toBe(
				"scratch edit",
			);
			expect(await run("cat", "/data/.config/muse/persistence-fixture")).toBe(
				"synthetic credential fixture",
			);
			await run(
				"git",
				"-C",
				"/data/.t3/worktrees/survivor",
				"status",
				"--porcelain",
			);
			expect(
				JSON.parse(await run("cat", "/data/.t3/userdata/settings.json"))
					.enableProviderUpdateChecks,
			).toBe(false);
			const environment = await readEnvironment(name);
			expect(environment.environmentId).toBe(identity);
			expect(environment.preferences.enableProviderUpdateChecks).toBe(false);
			expect(await run("bash", "-lc", "persistence-tool-fixture")).toBe(
				"persistent-bun-tool",
			);
			for (const shell of ["-c", "-lc"]) {
				expect(await run("bash", shell, "command -v muse && muse")).toBe("/data/.local/bin/muse\nuser-installed-muse");
			}
			expect(await run("/data/projects/survivor/.venv/bin/python", "-c", "import sqlite3; print(sqlite3.sqlite_version)")).toMatch(/^3\.\d+/);
			expect(await run("gh", "auth", "token", "--hostname", "github.com")).toBe("gho_synthetic_persistence_fixture");

			// Reselect dev in a third container with no network at all: the
			// payload in the home is relinked at start, with no download.
			await docker("rm", "--force", name);
			await start("dev", true);
			const { status: devOnly, group: devOffline } = await settled("dev", 60_000);
			expect(devOffline.state).toBe("ready");
			expect(devOffline.payload?.active).toBe(devFirst.payload?.active as string);
			expect(devOffline.payload?.last?.updatedAt).toBe(devFirst.payload?.last?.updatedAt as string);
			for (const shell of ["-c", "-lc"]) await run("bash", shell, `set -e; ${devTools}`);
			// Codex came back from the home with no network: nothing to reinstall.
			expect(await codexReady(0)).toMatchObject({ state: "ready", path: "/data/.local/bin/codex" });
			await run("codex", "--version");
			// Skills too: GitHub is out of reach, the refresh fails and waits to
			// retry, and every skill is still installed, unchanged.
			const skillsOffline = await skillsSettled(120_000);
			expect(skillsOffline.tokens[0]).toMatchObject({ state: "failed" });
			expect(skillsOffline.installer?.waitingUntil).toBeString();
			expect(skillsOffline.skills.map((s) => [s.name, s.state])).toEqual(skillsFirst.skills.map((s) => [s.name, "installed"]));
			expect(await run("head", "-1", `/data/.claude/skills/${skill}/SKILL.md`)).toBe("---");
			// The native groups deselected: their shims are gone, their payloads stay on disk.
			const nativeFirst = { capture: captureFirst, labs: labsFirst, vpn: vpnFirst, routing: routingFirst };
			const probes = { capture: "tshark", labs: "qemu-system-x86_64", vpn: "pki", routing: "bird" };
			for (const [group, first] of Object.entries(nativeFirst)) {
				const off = devOnly.groups.find((g) => g.name === group);
				expect(off?.state).toBe("not-selected");
				expect(off?.payload?.installed).toEqual([first.payload?.active as string]);
				expect(Bun.spawnSync(["docker", "exec", name, "bash", "-lc", `command -v ${probes[group as keyof typeof probes]}`]).exitCode).not.toBe(0);
			}

			// And they come back offline in a fourth container, still verified,
			// with nothing reinstalled.
			await docker("rm", "--force", name);
			await start("capture labs vpn routing", true);
			for (const [group, first] of Object.entries(nativeFirst)) {
				const { group: offline } = await settled(group, 60_000);
				expect(offline.state).toBe("ready");
				expect(offline.payload?.active).toBe(first.payload?.active as string);
				expect(offline.payload?.last?.updatedAt).toBe(first.payload?.last?.updatedAt as string);
				expect(await groupTools(group, "-c")).toContain(nativeOk[group as keyof typeof nativeOk]);
			}

			// The image default (no --env at all) is the explicit five-group
			// list: every payload relinks offline, nothing is reinstalled.
			const firsts = { ...nativeFirst, dev: devFirst };
			await docker("rm", "--force", name);
			await start(null, true);
			const { status: defaulted } = await settled("dev", 60_000);
			expect(defaulted.selector).toMatchObject({ raw: "capture labs vpn routing dev", defaulted: false, selected: ["capture", "labs", "vpn", "routing", "dev"], warnings: [] });
			for (const [group, first] of Object.entries(firsts)) {
				const { group: again } = await settled(group, 60_000);
				expect(again.state).toBe("ready");
				expect(again.payload?.active).toBe(first.payload?.active as string);
				expect(again.payload?.last?.updatedAt).toBe(first.payload?.last?.updatedAt as string);
			}

			// `none` is core only: every group deselected, payloads kept, core ready.
			await docker("rm", "--force", name);
			await start("none", true);
			const { status: coreOnly } = await settled("dev", 60_000);
			expect(coreOnly.selector.selected).toEqual([]);
			expect(coreOnly.core).toMatchObject({ state: "ready", missing: [] });
			for (const [group, first] of Object.entries(firsts)) {
				const off = coreOnly.groups.find((g) => g.name === group);
				expect(off?.state).toBe("not-selected");
				expect(off?.payload?.installed).toEqual([first.payload?.active as string]);
			}
			for (const probe of ["tsc", "tshark", "qemu-system-x86_64", "pki", "bird"]) {
				expect(Bun.spawnSync(["docker", "exec", name, "bash", "-lc", `command -v ${probe}`]).exitCode).not.toBe(0);
			}
		} finally {
			await docker("rm", "--force", name).catch(() => {});
			await docker("volume", "rm", volume);
		}
	},
	15 * 60_000,
);
