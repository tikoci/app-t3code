/** Real image replacement proof; run with APP_T3CODE_DOCKER_IMAGE=<local tag>. */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

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
		const start = (groups: string, offline = false) =>
			docker(
				"run",
				"--detach",
				"--name",
				name,
				...(offline ? ["--network", "none"] : ["--publish", "127.0.0.1::3773"]),
				"--volume",
				`${volume}:/data`,
				"--env",
				`T3CODE_TOOL_GROUPS=${groups}`,
				image as string,
			);
		/** The agent-facing status (live) and the runtime JSON the entrypoint wrote. */
		const toolStatus = async () => {
			type Status = {
				selector: { selected: string[]; unknown: string[]; warnings: string[] };
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
			const live = JSON.parse(await run("t3code-tools", "status", "--json")) as Status;
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
		const devTools = "cd /tmp; tsc --version; biome --version; cspell --version; markdownlint-cli2 --version";
		// A deb payload's functional script, as node with no capabilities
		// (test/capture-tools.sh, vpn-tools.sh, routing-tools.sh).
		// Against an emulated (QEMU user-mode) image, set CAPTURE_TOOLS_QEMU_USER
		// and/or ROUTING_TOOLS_QEMU_USER for this test: they are forwarded so the
		// scripts skip only checks that emulation breaks before any permission
		// check. Native runs keep every privilege check.
		const qemuFlags = ["CAPTURE_TOOLS_QEMU_USER", "ROUTING_TOOLS_QEMU_USER"].filter((key) => process.env[key]).map((key) => `${key}=1 `).join("");
		const groupTools = async (group: string, shell: string) => {
			await docker("cp", new URL(`./${group}-tools.sh`, import.meta.url).pathname, `${name}:/tmp/${group}-tools.sh`);
			return run("bash", shell, `${qemuFlags}bash /tmp/${group}-tools.sh`);
		};
		const captureTools = (shell: string) => groupTools("capture", shell);
		const nativeOk = { capture: "capture ok: TShark (Wireshark) ", vpn: "vpn ok: wireguard-tools ", routing: "routing ok: BIRD version " };
		await docker("volume", "create", volume);
		try {
			// CI exercises every group so the reported states cover the full set.
			await start("all");
			await waitForServer(name);
			expect(await run("printenv", "T3CODE_TELEMETRY_ENABLED")).toBe("false");
			// T3 is already serving; the dev, capture, vpn and routing payloads
			// install in the background, one after the other.
			const { group: devFirst } = await settled("dev", 180_000);
			expect(devFirst.payload?.last?.error).toBeUndefined();
			expect(devFirst.payload?.activeVersions?.["tsc"]).toStartWith("Version ");
			const { group: captureFirst } = await settled("capture", 300_000);
			expect(captureFirst.payload?.last?.error).toBeUndefined();
			expect(captureFirst.payload?.activeVersions?.["tshark"]).toStartWith("TShark (Wireshark) ");
			expect(captureFirst.payload?.active).toMatch(/^(amd64|arm64)-trixie-[0-9a-f]{16}$/);
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
				browser: "ready",
				"agents-extra": "ready",
			});
			for (const shell of ["-c", "-lc"]) {
				await run(
					"bash",
					shell,
					`set -e; bun --version; bunx --version; quickchr --help; centrs explain '/ip/address print' --json; muse --version; qemu-system-x86_64 --version; qemu-system-aarch64 --version; qemu-img --version; ${devTools}`,
				);
				for (const [group, ok] of Object.entries(nativeOk)) expect(await groupTools(group, shell)).toContain(ok);
			}
			await run(
				"bash",
				"-ec",
				`
mkdir -p /data/projects/survivor /data/.t3/projects/managed /data/.t3/scratch/survivor /data/.config/muse
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
			const identity = await run("cat", "/data/.t3/userdata/environment-id");
			expect(identity.length).toBeGreaterThan(0);
			// Stop before editing settings to avoid racing the live server's writer.
			await docker("stop", name);
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
			await start("capture+bogus labs");
			await waitForServer(name);
			const partial = await toolStatus();
			expect(partial.selector.selected).toEqual(["capture", "labs"]);
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

			// Reselect dev in a third container with no network at all: the
			// payload in the home is relinked at start, with no download.
			await docker("rm", "--force", name);
			await start("dev", true);
			const { status: devOnly, group: devOffline } = await settled("dev", 60_000);
			expect(devOffline.state).toBe("ready");
			expect(devOffline.payload?.active).toBe(devFirst.payload?.active as string);
			expect(devOffline.payload?.last?.updatedAt).toBe(devFirst.payload?.last?.updatedAt as string);
			for (const shell of ["-c", "-lc"]) await run("bash", shell, `set -e; ${devTools}`);
			// The native groups deselected: their shims are gone, their payloads stay on disk.
			const nativeFirst = { capture: captureFirst, vpn: vpnFirst, routing: routingFirst };
			const probes = { capture: "tshark", vpn: "pki", routing: "bird" };
			for (const [group, first] of Object.entries(nativeFirst)) {
				const off = devOnly.groups.find((g) => g.name === group);
				expect(off?.state).toBe("not-selected");
				expect(off?.payload?.installed).toEqual([first.payload?.active as string]);
				expect(Bun.spawnSync(["docker", "exec", name, "bash", "-lc", `command -v ${probes[group as keyof typeof probes]}`]).exitCode).not.toBe(0);
			}

			// And they come back offline in a fourth container, still verified,
			// with nothing reinstalled.
			await docker("rm", "--force", name);
			await start("capture vpn routing", true);
			for (const [group, first] of Object.entries(nativeFirst)) {
				const { group: offline } = await settled(group, 60_000);
				expect(offline.state).toBe("ready");
				expect(offline.payload?.active).toBe(first.payload?.active as string);
				expect(offline.payload?.last?.updatedAt).toBe(first.payload?.last?.updatedAt as string);
				expect(await groupTools(group, "-c")).toContain(nativeOk[group as keyof typeof nativeOk]);
			}
		} finally {
			await docker("rm", "--force", name).catch(() => {});
			await docker("volume", "rm", volume);
		}
	},
	15 * 60_000,
);
