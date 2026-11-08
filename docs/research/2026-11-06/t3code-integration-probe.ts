/**
 * Offline research fixture; use ONLY in a disposable container, with no mounts:
 * docker run --rm -i --network none --user 0 \
 *   -e T3CODE_RESEARCH_DISPOSABLE=1 --entrypoint bun app-t3code:slice4 - \
 *   < docs/research/2026-11-06/t3code-integration-probe.ts
 * No model calls, provider credentials, RouterOS writes, or host ports.
 * Patches the disposable container's index.html to check static delivery only.
 */
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.T3CODE_RESEARCH_DISPOSABLE !== "1") {
	throw new Error("Run only in a disposable container using the documented command.");
}

const root = await mkdtemp(join(tmpdir(), "t3-integration-"));
const home = join(root, "home");
const workspace = join(root, "workspace");
await mkdir(join(workspace, ".git"), { recursive: true });
const fixtures: Record<string, string> = {
	"research-home-root": join(home, "SKILL.md"),
	"research-t3-home": join(home, ".t3/skills/research-t3-home/SKILL.md"),
	"research-agents-user": join(home, ".agents/skills/research-agents-user/SKILL.md"),
	"research-codex-user": join(home, ".codex/skills/research-codex-user/SKILL.md"),
	"research-claude-user": join(home, ".claude/skills/research-claude-user/SKILL.md"),
	"research-opencode-user": join(home, ".config/opencode/skills/research-opencode-user/SKILL.md"),
	"research-repo": join(workspace, ".agents/skills/research-repo/SKILL.md"),
	"research-symlink-user": join(root, "image-skills/research-symlink-user/SKILL.md"),
};
for (const [name, path] of Object.entries(fixtures)) {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, `---\nname: ${name}\ndescription: Offline skill discovery fixture.\n---\nReport that this fixture was selected.\n`);
}
await symlink(join(root, "image-skills/research-symlink-user"), join(home, ".agents/skills/research-symlink-user"));
const environment = {
	...process.env,
	HOME: home,
	CODEX_HOME: join(home, ".codex"),
	XDG_CONFIG_HOME: join(home, ".config"),
	XDG_DATA_HOME: join(home, ".local/share"),
	XDG_CACHE_HOME: join(home, ".cache"),
	XDG_STATE_HOME: join(home, ".local/state"),
};

async function capture(args: string[], timeoutMs = 20000) {
	const child = Bun.spawn(args, { cwd: workspace, env: environment, stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { exitCode, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
}

const codex = Bun.spawn(["codex", "app-server"], { cwd: workspace, env: environment, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
const codexTimer = setTimeout(() => codex.kill("SIGKILL"), 20000);
let codexSkills: unknown = null;
try {
	codex.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "offline-research", version: "1" }, capabilities: { experimentalApi: true } } })}\n`);
	let pending = "";
	for await (const chunk of codex.stdout) {
		pending += new TextDecoder().decode(chunk);
		let newline = pending.indexOf("\n");
		while (newline !== -1) {
			const message = JSON.parse(pending.slice(0, newline));
			pending = pending.slice(newline + 1);
			if (message.id === 1) {
				if (message.error) throw new Error(JSON.stringify(message.error));
				codex.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
				codex.stdin.write(`${JSON.stringify({ id: 2, method: "skills/list", params: { cwds: [workspace], forceReload: true } })}\n`);
			}
			if (message.id === 2) {
				codexSkills = message.result ? {
					data: message.result.data.map((entry: { cwd: string; skills: { name: string }[]; errors: unknown[] }) => ({
						...entry,
						skills: entry.skills.filter((skill) => skill.name.startsWith("research-")),
						otherSkillNames: entry.skills.filter((skill) => !skill.name.startsWith("research-")).map((skill) => skill.name),
					})),
				} : message.error;
			}
			newline = pending.indexOf("\n");
		}
		if (codexSkills !== null) break;
	}
} finally {
	clearTimeout(codexTimer);
	codex.kill();
	await codex.exited;
}

const openCodeResult = await capture(["opencode", "debug", "skill"]);
let openCodeSkills: unknown;
try {
	const inventory = JSON.parse(openCodeResult.stdout) as { name: string }[];
	openCodeSkills = {
		exitCode: openCodeResult.exitCode,
		skills: inventory.filter((skill) => skill.name.startsWith("research-")),
		otherSkillNames: inventory.filter((skill) => !skill.name.startsWith("research-")).map((skill) => skill.name),
	};
} catch {
	openCodeSkills = openCodeResult;
}

const clientRoot = "/opt/t3code/client";
const indexPath = join(clientRoot, "index.html");
const index = await readFile(indexPath, "utf8");
const marker = "routeros-research-static-marker";
await writeFile(indexPath, index.replace("</head>", `<script src="/routeros-research.js"></script></head>`));
await writeFile(join(clientRoot, "routeros-research.js"), `/* ${marker} */\n`);
const assets = await readdir(join(clientRoot, "assets"));
const pairingTextFiles: string[] = [];
for (const name of assets.filter((name) => name.endsWith(".js"))) {
	if ((await readFile(join(clientRoot, "assets", name), "utf8")).includes("Pair with this environment")) pairingTextFiles.push(name);
}
const t3Environment = { ...environment, T3CODE_HOME: join(home, ".t3"), T3CODE_TELEMETRY_ENABLED: "false" };
const t3 = Bun.spawn(["t3", "serve", "--host", "127.0.0.1", "--port", "3773"], { cwd: workspace, env: t3Environment, stdout: "ignore", stderr: "ignore" });
let httpResults: unknown;
try {
	const deadline = Date.now() + 45000;
	while (true) {
		try {
			const response = await fetch("http://127.0.0.1:3773/", { signal: AbortSignal.timeout(2000) });
			if (response.ok) break;
		} catch { /* Server still starting. */ }
		if (Date.now() >= deadline) throw new Error("T3 did not start within 45 seconds.");
		await Bun.sleep(200);
	}
	const paths = ["/", "/pair", "/routeros-research.js", "/api/auth/session", ...pairingTextFiles.map((name) => `/assets/${name}`)];
	const results = [];
	for (const path of paths) {
		const response = await fetch(`http://127.0.0.1:3773${path}`, { signal: AbortSignal.timeout(3000) });
		const body = await response.text();
		results.push({ path, status: response.status, cacheControl: response.headers.get("cache-control"), contentType: response.headers.get("content-type"), csp: response.headers.get("content-security-policy"), injectedScript: body.includes('/routeros-research.js'), marker: body.includes(marker), ...(path === "/api/auth/session" ? { body: JSON.parse(body) } : {}) });
	}
	httpResults = results;
} finally {
	t3.kill();
	await t3.exited;
}

console.log(JSON.stringify({ versions: { t3: (await capture(["t3", "--version"])).stdout.trim(), codex: (await capture(["codex", "--version"])).stdout.trim(), opencode: (await capture(["opencode", "--version"])).stdout.trim() }, fixtures, codexSkills, openCodeSkills, web: { clientRoot, pairingTextFiles, manifestPresent: await Bun.file(join(clientRoot, ".vite/manifest.json")).exists(), httpResults } }, null, 2).replaceAll(root, "<fixture>"));
