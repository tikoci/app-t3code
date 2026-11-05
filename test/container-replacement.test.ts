/** Real image replacement proof; run with APP_T3CODE_DOCKER_IMAGE=<local tag>. */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

const image = process.env["APP_T3CODE_DOCKER_IMAGE"];
const expectedVersion = process.env["APP_T3CODE_T3VER"] ??
	(await Bun.file(new URL("../package.json", import.meta.url)).json()).version;

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

test.skipIf(!image)(
	"agents find the baked tools and T3 projects/settings survive container replacement",
	async () => {
		const name = `app-t3code-replacement-${randomUUID()}`;
		const volume = `${name}-data`;
		const run = (...args: string[]) => docker("exec", name, ...args);
		const start = () =>
			docker(
				"run",
				"--detach",
				"--name",
				name,
				"--publish",
				"127.0.0.1::3773",
				"--volume",
				`${volume}:/data`,
				"--env",
				"T3CODE_TELEMETRY_ENABLED=false",
				image as string,
			);
		await docker("volume", "create", volume);
		try {
			await start();
			await waitForServer(name);
			for (const shell of ["-c", "-lc"]) {
				await run(
					"bash",
					shell,
					"set -e; bun --version; bunx --version; quickchr --help; centrs explain '/ip/address print' --json; muse --version; qemu-system-x86_64 --version; qemu-system-aarch64 --version; qemu-img --version",
				);
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

			// A new writable layer and container id, with only the same named home volume.
			await start();
			await waitForServer(name);
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
			expect(await run("bash", "-lc", "persistence-tool-fixture")).toBe(
				"persistent-bun-tool",
			);
		} finally {
			await docker("rm", "--force", name).catch(() => {});
			await docker("volume", "rm", volume);
		}
	},
	5 * 60_000,
);
