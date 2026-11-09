/**
 * bin/install-claude-code (#13), offline: a fake downloads.claude.ai and a fake
 * `claude` whose `install <ver>` writes the launcher link the way the real
 * one does (measured 2026-11-08: with versions/<ver> staged it only links).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_PLATFORMS, CLAUDE_RELEASES_URL, claudeManifestAssets } from "../scripts/freshness.ts";

const SCRIPT = join(import.meta.dir, "..", "bin", "install-claude-code");
const ENTRYPOINT = readFileSync(join(import.meta.dir, "..", "docker-entrypoint.sh"), "utf8");
const VERSION = "2.1.311";
const PLATFORM = process.arch === "arm64" ? "linux-arm64" : "linux-x64";

/** A fake native build: `--version` and `install <ver>` (link ~/.local/bin/claude to versions/<ver>). */
function fakeClaude(version: string): string {
	return `#!/bin/sh
case "$1" in
--version) echo "${version} (Claude Code)" ;;
install)
	[ -e "$HOME/install-fails" ] && { echo "install failed" >&2; exit 1; }
	echo "install $2" >> "$HOME/install-calls"
	mkdir -p "$HOME/.local/bin"
	ln -sfn "$HOME/.local/share/claude/versions/$2" "$HOME/.local/bin/claude"
	echo '{"installMethod":"native"}' > "$HOME/.claude.json" ;;
*) exit 2 ;;
esac
`;
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

// Mutable server behaviour, reset before each test.
let binary = fakeClaude(VERSION);
let pointer = VERSION;
let manifest: unknown;
// Answer the first N requests with a 404, which curl does not retry by itself,
// so each failed round costs one request and no curl back-off.
let failFirst = 0;
let requests: string[] = [];

const server = Bun.serve({
	port: 0,
	fetch(req) {
		const path = new URL(req.url).pathname;
		requests.push(`${req.method} ${path}${req.headers.get("range") ? ` ${req.headers.get("range")}` : ""}`);
		if (failFirst > 0) {
			failFirst--;
			return new Response("not yet", { status: 404 });
		}
		if (path === "/stable" || path === "/latest") return new Response(`${pointer}\n`);
		if (path === `/${VERSION}/manifest.json`) return Response.json(manifest);
		if (path === `/${VERSION}/${PLATFORM}/claude`) {
			const body = new TextEncoder().encode(binary);
			const range = req.headers.get("range")?.match(/^bytes=(\d+)-$/);
			if (range) {
				const start = Number(range[1]);
				if (start >= body.length) return new Response(null, { status: 416, headers: { "content-range": `bytes */${body.length}` } });
				return new Response(body.slice(start), { status: 206, headers: { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` } });
			}
			return new Response(body);
		}
		return new Response("not found", { status: 404 });
	},
});

let home: string;

function realManifest(bin = binary) {
	const platforms: Record<string, unknown> = {};
	for (const p of [...CLAUDE_PLATFORMS, "darwin-arm64"]) platforms[p] = { binary: "claude", checksum: sha256(bin), size: Buffer.byteLength(bin) };
	return { buildDate: "2026-11-01T00:00:00Z", commit: "abc", manifestSignatureEnforcement: "off", platforms, sdkCompat: {}, version: VERSION };
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "install-claude-code-"));
	binary = fakeClaude(VERSION);
	pointer = VERSION;
	manifest = realManifest();
	failFirst = 0;
	requests = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
afterAll(() => server.stop(true));

/**
 * Run the installer with a PATH where only ~/.local/bin can provide `claude`.
 * Async: a synchronous spawn would block the fake server in this process.
 */
async function run(...args: string[]) {
	const proc = Bun.spawn(["bash", SCRIPT, ...args], {
		env: {
			HOME: home,
			PATH: `${home}/.local/bin:/usr/bin:/bin`,
			CLAUDE_CODE_RELEASES_URL: `http://127.0.0.1:${server.port}`,
			INSTALL_CLAUDE_CODE_BACKOFF: "0 0 0",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, out: out + err };
}

const staged = () => join(home, ".local/share/claude/versions", VERSION);
const launcher = () => join(home, ".local/bin/claude");
const downloads = () => requests.filter((r) => r.includes(`/${PLATFORM}/claude`));

beforeAll(() => {
	// The tests need `claude` to come only from the temp home.
	const stray = Bun.spawnSync(["bash", "-c", "PATH=/usr/bin:/bin command -v claude"]).stdout.toString().trim();
	if (stray) throw new Error(`a claude in /usr/bin or /bin (${stray}) would mask the installer under test`);
});

describe("install-claude-code", () => {
	test("installs the stable channel's version: verified download, staged, then claude's own install", async () => {
		const { code, out } = await run();
		expect(code, out).toBe(0);
		expect(requests).toEqual(["GET /stable", `GET /${VERSION}/manifest.json`, `GET /${VERSION}/${PLATFORM}/claude`]);
		expect(readFileSync(staged(), "utf8")).toBe(binary);
		expect(readlinkSync(launcher())).toBe(staged());
		expect(readFileSync(join(home, "install-calls"), "utf8")).toBe(`install ${VERSION}\n`);
		expect(existsSync(join(home, ".claude/downloads", `claude-${VERSION}-${PLATFORM}.part`))).toBe(false);
		expect(out).toContain(`installed Claude Code ${VERSION}`);
	});

	test("an explicit version skips the channel pointer", async () => {
		const { code, out } = await run(VERSION);
		expect(code, out).toBe(0);
		expect(requests[0]).toBe(`GET /${VERSION}/manifest.json`);
	});

	test("a claude already on PATH wins: no request, nothing replaced", async () => {
		mkdirSync(join(home, ".local/bin"), { recursive: true });
		writeFileSync(launcher(), "#!/bin/sh\necho '9.9.9 (Claude Code)'\n");
		chmodSync(launcher(), 0o755);
		const { code, out } = await run("--keep-trying");
		expect(code, out).toBe(0);
		expect(requests).toEqual([]);
		expect(out).toContain("already installed");
		expect(out).toContain("9.9.9");
	});

	test("a checksum mismatch is discarded and nothing is installed", async () => {
		manifest = realManifest(fakeClaude("6.6.6"));
		const { code, out } = await run();
		expect(code, out).toBe(1);
		expect(out).toContain("failed its size or SHA-256 check");
		expect(existsSync(staged())).toBe(false);
		expect(existsSync(launcher())).toBe(false);
		expect(existsSync(join(home, ".claude/downloads", `claude-${VERSION}-${PLATFORM}.part`))).toBe(false);
	});

	test("the old schema (.artifacts[]) or a missing platform fails clearly, before any download", async () => {
		manifest = { artifacts: [{ arch: PLATFORM, url: "x", sha256: sha256(binary) }] };
		const { code, out } = await run();
		expect(code, out).toBe(1);
		expect(out).toContain(`no ${PLATFORM} checksum and size`);
		expect(downloads()).toEqual([]);
	});

	test("a channel pointer that is not a version (an HTML error page) stops before the manifest", async () => {
		pointer = "<html>blocked</html>";
		const { code, out } = await run();
		expect(code, out).toBe(1);
		expect(out).toContain("not a version");
		expect(requests).toEqual(["GET /stable"]);
	});

	test("a partial download resumes where it stopped", async () => {
		const part = join(home, ".claude/downloads", `claude-${VERSION}-${PLATFORM}.part`);
		mkdirSync(join(home, ".claude/downloads"), { recursive: true });
		writeFileSync(part, binary.slice(0, 40));
		const { code, out } = await run();
		expect(code, out).toBe(0);
		expect(downloads()).toEqual([`GET /${VERSION}/${PLATFORM}/claude bytes=40-`]);
		expect(readFileSync(staged(), "utf8")).toBe(binary);
	});

	test("a failed setup keeps the verified binary; the next run reuses it without downloading", async () => {
		writeFileSync(join(home, "install-fails"), "");
		let result = await run();
		expect(result.code, result.out).toBe(1);
		expect(result.out).toContain("is kept for the next attempt");
		expect(readFileSync(staged(), "utf8")).toBe(binary);
		expect(existsSync(launcher())).toBe(false);

		rmSync(join(home, "install-fails"));
		requests = [];
		result = await run();
		expect(result.code, result.out).toBe(0);
		expect(result.out).toContain("reusing the verified");
		expect(downloads()).toEqual([]);
		expect(readlinkSync(launcher())).toBe(staged());
	});

	test("a corrupt staged version is replaced by a fresh download", async () => {
		mkdirSync(join(home, ".local/share/claude/versions"), { recursive: true });
		writeFileSync(staged(), ""); // what an interrupted `claude install` leaves
		const { code, out } = await run();
		expect(code, out).toBe(0);
		expect(downloads()).toHaveLength(1);
		expect(readFileSync(staged(), "utf8")).toBe(binary);
	});

	test("without --keep-trying one attempt; with it, retries until the network answers", async () => {
		failFirst = 100;
		let result = await run();
		expect(result.code, result.out).toBe(1);
		expect(result.out).not.toContain("retrying");

		// The first round fails; the second gets through.
		failFirst = 1;
		requests = [];
		result = await run("--keep-trying");
		expect(result.code, result.out).toBe(0);
		expect(result.out).toContain("retrying in 0s");
		expect(readlinkSync(launcher())).toBe(staged());
	}, 30_000);

	test("--keep-trying gives up after its schedule", async () => {
		failFirst = 1000;
		const { code, out } = await run("--keep-trying");
		expect(code, out).toBe(1);
		expect(out).toContain("giving up");
		expect(out.match(/retrying in/g)).toHaveLength(3);
	}, 60_000);

	test("a second installer leaves a running one alone", async () => {
		mkdirSync(join(home, ".claude/downloads"), { recursive: true });
		const lock = join(home, ".claude/downloads/.install-claude-code.lock");
		const holder = Bun.spawn(["flock", lock, "sleep", "30"]);
		try {
			// Wait until the holder has the lock.
			for (let i = 0; i < 100 && Bun.spawnSync(["flock", "-n", lock, "true"]).exitCode === 0; i++) await Bun.sleep(20);
			const { code, out } = await run();
			expect(code, out).toBe(1);
			expect(out).toContain("another install-claude-code is running");
			expect(requests).toEqual([]);
		} finally {
			holder.kill();
			await holder.exited;
		}
	});

	test("bad arguments are a usage error", async () => {
		expect((await run("nightly")).code).toBe(2);
		expect((await run("--force")).code).toBe(2);
	});
});

describe("install-claude-code contract", () => {
	test("the script downloads from the URL and platforms the freshness check verifies", async () => {
		const script = readFileSync(SCRIPT, "utf8");
		expect(script).toContain(`RELEASES_URL="\${CLAUDE_CODE_RELEASES_URL:-${CLAUDE_RELEASES_URL}}"`);
		for (const platform of CLAUDE_PLATFORMS) expect(script).toContain(`platform=${platform}`);
		expect(script).toContain(".platforms[$p].checksum");
		expect(script).toContain(".platforms[$p].size");
	});

	test("the freshness parser accepts the real manifest shape and rejects the old one", async () => {
		const good = claudeManifestAssets(realManifest(), VERSION);
		expect(good.problems).toEqual([]);
		expect(Object.keys(good.assets)).toEqual([...CLAUDE_PLATFORMS]);
		expect(claudeManifestAssets({ artifacts: [] }, VERSION).problems).toEqual(["has no .platforms object"]);
		const noArm = realManifest() as { platforms: Record<string, unknown> };
		delete noArm.platforms["linux-arm64"];
		expect(claudeManifestAssets(noArm, VERSION).problems).toEqual(['has no .platforms["linux-arm64"] {checksum, size}']);
		expect(claudeManifestAssets({ ...realManifest(), version: "1.0.0" }, VERSION).problems).toEqual([`says version 1.0.0, not ${VERSION}`]);
	});

	test("the entrypoint retries in the background and logs into the home", async () => {
		expect(ENTRYPOINT).toMatch(/\/usr\/local\/bin\/install-claude-code --keep-trying >"\$\{HOME\}\/\.local\/state\/t3code\/install-claude-code\.log" 2>&1 &/);
		expect(ENTRYPOINT).not.toContain("/tmp/install-claude-code.log");
	});
});
