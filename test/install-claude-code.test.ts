/**
 * bin/install-claude-code (#13), offline: a fake downloads.claude.ai and a fake
 * `claude` whose `install <ver>` writes the launcher link the way the real
 * one does (measured 2026-11-08: with versions/<ver> staged it only links).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_PLATFORMS, CLAUDE_RELEASES_URL, checkClaude, claudeManifestAssets } from "../scripts/freshness.ts";

const SCRIPT = join(import.meta.dir, "..", "bin", "install-claude-code");
const ENTRYPOINT_PATH = join(import.meta.dir, "..", "docker-entrypoint.sh");
const ENTRYPOINT = readFileSync(ENTRYPOINT_PATH, "utf8");
const VERSION = "2.1.311";
const PLATFORM = process.arch === "arm64" ? "linux-arm64" : "linux-x64";

/**
 * A fake native build: `--version` and `install <ver>` (link ~/.local/bin/claude
 * to versions/<ver>). With ~/install-competing, it behaves like the real one
 * when T3's /welcome install.sh got there first: it keeps that launcher.
 */
function fakeClaude(version: string): string {
	return `#!/bin/sh
case "$1" in
--version) echo "${version} (Claude Code)" ;;
install)
	[ -e "$HOME/install-fails" ] && { echo "install failed" >&2; exit 1; }
	echo "install $2" >> "$HOME/install-calls"
	mkdir -p "$HOME/.local/bin"
	if [ -e "$HOME/install-competing" ]; then
		printf '#!/bin/sh\\necho "2.1.319 (Claude Code)"\\n' > "$HOME/.local/bin/claude"
		chmod +x "$HOME/.local/bin/claude"
		exit 0
	fi
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
let ignoreRange = false; // answer a Range request with 200 and the whole file
let stallAfter = 0; // the next binary download sends this many bytes, then stalls
let requests: string[] = [];
let headLength: "real" | "wrong" | "none" = "real"; // Content-Length on a HEAD for the binary
let zst: "real" | "missing" | "forbidden" | "corrupt" = "real"; // <platform>/claude.zst: the binary compressed, a 404, a 403, or not zstd
let unavailableFirst = 0; // answer the next N binary or .zst downloads with a 503
// The zstd the installer may use. Most tests take the uncompressed route (no
// zstd); the .zst tests point it at the host's real zstd.
const NO_ZSTD = "zstd-not-installed";
let zstdCommand = NO_ZSTD;

/** The body, or the part a `bytes=N-` Range asks for (unless ignoreRange). */
function ranged(req: Request, body: Uint8Array): Response {
	const range = ignoreRange ? null : req.headers.get("range")?.match(/^bytes=(\d+)-$/);
	if (range) {
		const start = Number(range[1]);
		if (start >= body.length) return new Response(null, { status: 416, headers: { "content-range": `bytes */${body.length}` } });
		return new Response(body.slice(start), { status: 206, headers: { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` } });
	}
	return new Response(body);
}

const compressed = () => (zst === "corrupt" ? new TextEncoder().encode("this is not zstd") : Bun.zstdCompressSync(new TextEncoder().encode(binary)));

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
		const isDownload = CLAUDE_PLATFORMS.some((p) => path === `/${VERSION}/${p}/claude` || path === `/${VERSION}/${p}/claude.zst`);
		if (isDownload && req.method === "GET" && unavailableFirst > 0) {
			unavailableFirst--;
			return new Response("busy", { status: 503 });
		}
		if (CLAUDE_PLATFORMS.some((p) => path === `/${VERSION}/${p}/claude`)) {
			const body = new TextEncoder().encode(binary);
			if (req.method === "HEAD" && headLength === "wrong") return new Response(null, { headers: { "content-length": "7" } });
			// A non-empty stream has no known length: Bun answers chunked, with no Content-Length.
			if (req.method === "HEAD" && headLength === "none") {
				return new Response(
					new ReadableStream({
						start: (c) => {
							c.enqueue(body.slice(0, 1));
							c.close();
						},
					}),
				);
			}
			if (stallAfter > 0) {
				const prefix = body.slice(0, stallAfter);
				stallAfter = 0;
				return new Response(new ReadableStream({ start: (c) => c.enqueue(prefix) }));
			}
			return ranged(req, body);
		}
		if (CLAUDE_PLATFORMS.some((p) => path === `/${VERSION}/${p}/claude.zst`)) {
			if (zst === "missing") return new Response("not found", { status: 404 });
			if (zst === "forbidden") return new Response("forbidden", { status: 403 });
			const body = compressed();
			if (req.method === "HEAD") return new Response(null, { headers: { "content-length": String(body.length) } });
			return ranged(req, body);
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
	ignoreRange = false;
	stallAfter = 0;
	headLength = "real";
	zst = "real";
	unavailableFirst = 0;
	zstdCommand = NO_ZSTD;
	requests = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
afterAll(() => server.stop(true));

/**
 * Run the installer with a PATH where only ~/.local/bin can provide `claude`.
 * Async: a synchronous spawn would block the fake server in this process.
 */
async function run(...args: string[]) {
	// The installer refuses root. A root runner (a container) runs it as nobody,
	// with util-linux setpriv, and hands it the temp home.
	const asNobody = process.getuid?.() === 0 ? ["setpriv", "--reuid=65534", "--regid=65534", "--clear-groups"] : [];
	if (asNobody.length) Bun.spawnSync(["chown", "-R", "65534:65534", home]);
	const proc = Bun.spawn([...asNobody, "bash", SCRIPT, ...args], {
		env: {
			HOME: home,
			PATH: `${home}/.local/bin:/usr/bin:/bin`,
			CLAUDE_CODE_RELEASES_URL: `http://127.0.0.1:${server.port}`,
			INSTALL_CLAUDE_CODE_BACKOFF: "0 0 0",
			INSTALL_CLAUDE_CODE_STALL_SECONDS: "1",
			INSTALL_CLAUDE_CODE_ZSTD: zstdCommand,
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
const partFile = () => join(home, ".claude/downloads", `claude-${VERSION}-${PLATFORM}.part`);
const zstPart = () => join(home, ".claude/downloads", `claude-${VERSION}-${PLATFORM}.zst.part`);

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

	test("a 503 is retried within the attempt, not treated as a missing file", async () => {
		unavailableFirst = 1;
		const { code, out } = await run();
		expect(code, out).toBe(0);
		expect(out).toContain("HTTP 503");
		expect(downloads()).toEqual([`GET /${VERSION}/${PLATFORM}/claude`, `GET /${VERSION}/${PLATFORM}/claude`]);
	});

	test("a verified staged version that lost its execute bit is reused, made executable", async () => {
		mkdirSync(join(home, ".local/share/claude/versions"), { recursive: true });
		writeFileSync(staged(), binary, { mode: 0o644 });
		const { code, out } = await run();
		expect(code, out).toBe(0);
		expect(out).toContain("reusing the verified");
		expect(downloads()).toEqual([]);
		expect(statSync(staged()).mode & 0o111).toBe(0o111);
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
		// -o: sleep does not inherit the lock, so killing flock releases it.
		const holder = Bun.spawn(["flock", "-o", lock, "sleep", "30"]);
		try {
			const free = () => Bun.spawnSync(["flock", "-n", lock, "true"]).exitCode === 0;
			for (let i = 0; i < 100 && free(); i++) await Bun.sleep(20);
			expect(free()).toBe(false);
			const { code, out } = await run();
			expect(code, out).toBe(1);
			expect(out).toContain("another install-claude-code is running");
			expect(requests).toEqual([]);

			// A claude that T3's /welcome installed meanwhile is a success, lock or not.
			mkdirSync(join(home, ".local/bin"), { recursive: true });
			writeFileSync(launcher(), "#!/bin/sh\necho '2.1.319 (Claude Code)'\n", { mode: 0o755 });
			const after = await run();
			expect(after.code, after.out).toBe(0);
			expect(after.out).toContain("already installed");
			expect(after.out).not.toContain("another install-claude-code is running");
			expect(requests).toEqual([]);
		} finally {
			holder.kill();
			await holder.exited;
		}
	});

	test("a server that refuses to resume (200 to a Range request) gets a fresh download", async () => {
		const part = join(home, ".claude/downloads", `claude-${VERSION}-${PLATFORM}.part`);
		mkdirSync(join(home, ".claude/downloads"), { recursive: true });
		writeFileSync(part, binary.slice(0, 40));
		ignoreRange = true;
		const { code, out } = await run();
		expect(code, out).toBe(0);
		expect(out).toContain("refused to resume");
		expect(downloads()).toEqual([`GET /${VERSION}/${PLATFORM}/claude bytes=40-`, `GET /${VERSION}/${PLATFORM}/claude`]);
		expect(readFileSync(staged(), "utf8")).toBe(binary);
	});

	test("a complete, verified partial needs no binary request", async () => {
		mkdirSync(join(home, ".claude/downloads"), { recursive: true });
		writeFileSync(join(home, ".claude/downloads", `claude-${VERSION}-${PLATFORM}.part`), binary);
		const { code, out } = await run();
		expect(code, out).toBe(0);
		expect(downloads()).toEqual([]);
		expect(readFileSync(staged(), "utf8")).toBe(binary);
	});

	test("a stalled download is abandoned and resumed", async () => {
		stallAfter = 50;
		const { code, out } = await run();
		expect(code, out).toBe(0);
		expect(out).toContain("download stopped (curl exit 28)");
		expect(downloads()).toEqual([`GET /${VERSION}/${PLATFORM}/claude`, `GET /${VERSION}/${PLATFORM}/claude bytes=50-`]);
		expect(readFileSync(staged(), "utf8")).toBe(binary);
	}, 30_000);

	test("T3's /welcome finishing first is a success, not a version mismatch", async () => {
		writeFileSync(join(home, "install-competing"), "");
		const { code, out } = await run();
		expect(code, out).toBe(0);
		expect(out).toContain("another installer finished first");
		expect(out).toContain("2.1.319");
	});

	test("a manifest for another version is refused, as in the freshness check", async () => {
		manifest = { ...realManifest(), version: "1.0.0" };
		const { code, out } = await run();
		expect(code, out).toBe(1);
		expect(out).toContain("says version 1.0.0");
		expect(downloads()).toEqual([]);
	});

	test("an unusable lock file is an error, not another installer", async () => {
		mkdirSync(join(home, ".claude/downloads/.install-claude-code.lock"), { recursive: true });
		const { code, out } = await run();
		expect(code, out).toBe(1);
		expect(out).toContain("cannot open the lock file");
		expect(out).not.toContain("another install-claude-code is running");
	});

	test("bad arguments are a usage error", async () => {
		expect((await run("nightly")).code).toBe(2);
		expect((await run("--force")).code).toBe(2);
	});
});

/** The image's route: zstd is core, so the installer fetches claude.zst first. */
describe("install-claude-code with zstd", () => {
	beforeEach(() => {
		const real = Bun.which("zstd");
		if (!real) throw new Error("these tests need the zstd CLI (the image and GitHub's Ubuntu runners have it)");
		zstdCommand = real;
	});

	test("downloads the .zst only, decompresses and verifies it against the manifest, then installs", async () => {
		const { code, out } = await run();
		expect(code, out).toBe(0);
		expect(requests).toEqual(["GET /stable", `GET /${VERSION}/manifest.json`, `GET /${VERSION}/${PLATFORM}/claude.zst`]);
		expect(readFileSync(staged(), "utf8")).toBe(binary);
		expect(readlinkSync(launcher())).toBe(staged());
		expect(existsSync(zstPart())).toBe(false);
		expect(existsSync(partFile())).toBe(false);
		expect(out).toContain("compressed");
		expect(out).toContain(`installed Claude Code ${VERSION}`);
	});

	test("no .zst upstream (an HTTP error): falls back to the uncompressed binary in the same attempt", async () => {
		zst = "missing";
		const { code, out } = await run();
		expect(code, out).toBe(0);
		expect(downloads()).toEqual([`GET /${VERSION}/${PLATFORM}/claude.zst`, `GET /${VERSION}/${PLATFORM}/claude`]);
		expect(out).toContain("no compressed build");
		expect(readFileSync(staged(), "utf8")).toBe(binary);
	});

	test("a 403 on the .zst also counts as missing (object stores answer 403 for absent keys)", async () => {
		zst = "forbidden";
		const { code, out } = await run();
		expect(code, out).toBe(0);
		expect(downloads()).toEqual([`GET /${VERSION}/${PLATFORM}/claude.zst`, `GET /${VERSION}/${PLATFORM}/claude`]);
	});

	test("a 503 on the .zst is retried; no fallback to the uncompressed download", async () => {
		unavailableFirst = 1;
		const { code, out } = await run();
		expect(code, out).toBe(0);
		expect(out).toContain("HTTP 503");
		expect(downloads()).toEqual([`GET /${VERSION}/${PLATFORM}/claude.zst`, `GET /${VERSION}/${PLATFORM}/claude.zst`]);
	});

	test("a .zst partial survives an attempt that keeps getting 503s", async () => {
		mkdirSync(join(home, ".claude/downloads"), { recursive: true });
		writeFileSync(zstPart(), compressed().slice(0, 10));
		unavailableFirst = 3;
		const { code, out } = await run();
		expect(code, out).toBe(1);
		expect(out).toContain("a later attempt resumes it");
		expect(statSync(zstPart()).size).toBe(10);
		expect(downloads().every((r) => r.includes("claude.zst"))).toBe(true);
	});

	test("a .zst left after decompressing is removed once the binary is verified", async () => {
		mkdirSync(join(home, ".claude/downloads"), { recursive: true });
		writeFileSync(partFile(), binary);
		writeFileSync(zstPart(), compressed());
		const { code, out } = await run();
		expect(code, out).toBe(0);
		expect(downloads()).toEqual([]);
		expect(existsSync(zstPart())).toBe(false);
		expect(readFileSync(staged(), "utf8")).toBe(binary);
	});

	test("a .zst that does not decompress is discarded; the next attempt starts over", async () => {
		zst = "corrupt";
		let { code, out } = await run();
		expect(code, out).toBe(1);
		expect(out).toContain("did not decompress");
		expect(existsSync(zstPart())).toBe(false);
		expect(existsSync(partFile())).toBe(false);
		expect(existsSync(staged())).toBe(false);

		zst = "real";
		requests = [];
		({ code, out } = await run());
		expect(code, out).toBe(0);
		expect(downloads()).toEqual([`GET /${VERSION}/${PLATFORM}/claude.zst`]);
	});

	test("a decompressed binary that fails the manifest's checksum is discarded", async () => {
		manifest = realManifest(fakeClaude("6.6.6"));
		const { code, out } = await run();
		expect(code, out).toBe(1);
		expect(out).toContain("failed its size or SHA-256 check");
		expect(existsSync(zstPart())).toBe(false);
		expect(existsSync(partFile())).toBe(false);
		expect(existsSync(staged())).toBe(false);
	});

	test("a partial .zst resumes where it stopped", async () => {
		const full = compressed();
		mkdirSync(join(home, ".claude/downloads"), { recursive: true });
		writeFileSync(zstPart(), full.slice(0, 10));
		const { code, out } = await run();
		expect(code, out).toBe(0);
		expect(downloads()).toEqual([`GET /${VERSION}/${PLATFORM}/claude.zst bytes=10-`]);
		expect(out).toContain("resuming at 0 MiB");
		expect(readFileSync(staged(), "utf8")).toBe(binary);
	});

	test("a complete .zst left by an interrupted run is used without downloading it again", async () => {
		mkdirSync(join(home, ".claude/downloads"), { recursive: true });
		writeFileSync(zstPart(), compressed());
		const { code, out } = await run();
		expect(code, out).toBe(0);
		// curl's resume asks past the end; the server's 416 means "already complete".
		expect(downloads()).toEqual([`GET /${VERSION}/${PLATFORM}/claude.zst bytes=${compressed().length}-`]);
		expect(readFileSync(staged(), "utf8")).toBe(binary);
	});

	test("an uncompressed partial from an earlier run is resumed, not replaced by the .zst", async () => {
		mkdirSync(join(home, ".claude/downloads"), { recursive: true });
		writeFileSync(partFile(), binary.slice(0, 10));
		const { code, out } = await run();
		expect(code, out).toBe(0);
		expect(downloads()).toEqual([`GET /${VERSION}/${PLATFORM}/claude bytes=10-`]);
	});
});

describe("install-claude-code contract", () => {
	test("the script downloads from the URL and platforms the freshness check verifies", async () => {
		const script = readFileSync(SCRIPT, "utf8");
		expect(script).toContain(`RELEASES_URL="\${CLAUDE_CODE_RELEASES_URL:-${CLAUDE_RELEASES_URL}}"`);
		for (const platform of CLAUDE_PLATFORMS) expect(script).toContain(`platform=${platform}`);
		expect(script).toContain(".platforms[$p].checksum");
		expect(script).toContain(".platforms[$p].size");
		expect(script).toContain(`url="\${RELEASES_URL}/\${version}/\${platform}/claude"`);
		expect(script).toContain(`download "$zpart" "\${url}.zst"`);
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
		// jq -r prints "123" and 123 alike, so the installer accepts both.
		const stringSize = realManifest() as { platforms: Record<string, { size: unknown }> };
		for (const p of CLAUDE_PLATFORMS) stringSize.platforms[p] = { ...stringSize.platforms[p], size: String(Buffer.byteLength(binary)) };
		expect(claudeManifestAssets(stringSize, VERSION)).toEqual(good);
		const badSize = realManifest() as { platforms: Record<string, { size: unknown }> };
		badSize.platforms["linux-x64"] = { ...badSize.platforms["linux-x64"], size: "12 MiB" };
		expect(claudeManifestAssets(badSize, VERSION).problems).toEqual(['has no .platforms["linux-x64"] {checksum, size}']);
	});

	// freshness.ts `claude`, against the same fake download server.
	const base = () => `http://127.0.0.1:${server.port}`;
	const heads = () => requests.filter((r) => r.startsWith("HEAD "));

	test("freshness claude: the channel, its manifest, then a HEAD per Linux binary and its .zst", async () => {
		const report = await checkClaude("stable", base());
		expect(report.ok, report.lines.join("\n")).toBe(true);
		expect(report.lines).toEqual([`Claude Code stable ${VERSION}: manifest, linux-x64 + linux-arm64 binaries and .zst builds match bin/install-claude-code`]);
		expect(requests).toEqual([
			"GET /stable",
			`GET /${VERSION}/manifest.json`,
			...CLAUDE_PLATFORMS.flatMap((p) => [`HEAD /${VERSION}/${p}/claude`, `HEAD /${VERSION}/${p}/claude.zst`]),
		]);
	});

	test("freshness claude: a missing .zst fails, naming the fallback", async () => {
		zst = "missing";
		const report = await checkClaude("stable", base());
		expect(report.ok).toBe(false);
		expect(report.lines[0]).toContain("linux-x64/claude.zst is missing (the installer falls back to the uncompressed binary)");
		expect(report.lines[0]).toContain("linux-arm64/claude.zst is missing");
	});

	test("freshness claude: a binary whose length differs from the manifest fails", async () => {
		headLength = "wrong";
		const report = await checkClaude("stable", base());
		expect(report.ok).toBe(false);
		expect(report.lines[0]).toContain(`linux-x64/claude is 7 bytes, but the manifest says ${Buffer.byteLength(binary)}`);
		expect(report.lines[0]).toContain("update bin/install-claude-code");
	});

	test("freshness claude: no Content-Length is a note, not a failure", async () => {
		headLength = "none";
		const report = await checkClaude("stable", base());
		expect(report.ok, report.lines.join("\n")).toBe(true);
		expect(report.lines[1]).toContain("no Content-Length for linux-x64 + linux-arm64/claude; size not checked");
		expect(heads()).toHaveLength(4);
	});

	test("freshness claude: a pointer that is not a version, or the old manifest, fails before any HEAD", async () => {
		pointer = "<html>maintenance</html>";
		let report = await checkClaude("stable", base());
		expect(report.ok).toBe(false);
		expect(report.lines[0]).toContain("not a version");

		pointer = VERSION;
		manifest = { artifacts: [] };
		report = await checkClaude("stable", base());
		expect(report.ok).toBe(false);
		expect(report.lines[0]).toContain("has no .platforms object");
		expect(heads()).toEqual([]);
	});

	test("the entrypoint retries in the background and appends to a log in the home", async () => {
		expect(ENTRYPOINT).toMatch(/claude_log="\$\{HOME\}\/\.local\/state\/t3code\/install-claude-code\.log"/);
		expect(ENTRYPOINT).toContain("/usr/local/bin/install-claude-code --keep-trying >>");
		expect(ENTRYPOINT).not.toContain("/tmp/install-claude-code.log");
	});
});

/**
 * docker-entrypoint.sh's Claude block, run for real: the installer and
 * t3code-tools paths are swapped for a fake installer and a missing file.
 */
describe("entrypoint and the Claude install log", () => {
	let dir: string;
	let entrypoint: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "entrypoint-"));
		const fake = join(dir, "fake-installer");
		writeFileSync(fake, '#!/bin/sh\necho "fake installer ran: $*"\n');
		chmodSync(fake, 0o755);
		entrypoint = join(dir, "entrypoint.sh");
		writeFileSync(entrypoint, ENTRYPOINT.replaceAll("/usr/local/bin/install-claude-code", fake).replaceAll("/usr/local/bin/t3code-tools", join(dir, "absent")));
		mkdirSync(join(dir, "home"));
	});
	afterEach(() => {
		chmodSync(dir, 0o755);
		Bun.spawnSync(["chmod", "-R", "u+w", dir]);
		rmSync(dir, { recursive: true, force: true });
	});

	async function start() {
		const proc = Bun.spawn(["bash", entrypoint, "sh", "-c", "echo server started"], {
			env: { HOME: join(dir, "home"), PATH: "/usr/bin:/bin" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, out, err };
	}
	const log = () => join(dir, "home/.local/state/t3code/install-claude-code.log");

	test("each start appends to the persistent log", async () => {
		for (let i = 0; i < 2; i++) {
			const { code, out, err } = await start();
			expect(code, err).toBe(0);
			expect(out).toContain("server started");
		}
		for (let i = 0; i < 100 && (readFileSync(log(), "utf8").match(/fake installer ran/g) ?? []).length < 2; i++) await Bun.sleep(20);
		expect(readFileSync(log(), "utf8").match(/fake installer ran: --keep-trying/g)).toHaveLength(2);
	});

	test("a log over 1 MiB is rotated once", async () => {
		mkdirSync(join(dir, "home/.local/state/t3code"), { recursive: true });
		writeFileSync(log(), "x".repeat(1048577));
		expect((await start()).code).toBe(0);
		expect(statSync(`${log()}.1`).size).toBe(1048577);
		for (let i = 0; i < 100 && !readFileSync(log(), "utf8").includes("fake installer ran"); i++) await Bun.sleep(20);
		expect(readFileSync(log(), "utf8")).toStartWith("fake installer ran");
	});

	test.skipIf(process.getuid?.() === 0)("an unwritable state directory never stops the server", async () => {
		mkdirSync(join(dir, "home/.local/state"), { recursive: true });
		chmodSync(join(dir, "home/.local/state"), 0o555);
		const { code, out, err } = await start();
		expect(code, err).toBe(0);
		expect(out).toContain("server started");
		expect(err).toContain("cannot write");
		// stderr closes only once the background installer has exited too.
		expect(err).toContain("fake installer ran: --keep-trying");
	});

	test.skipIf(process.getuid?.() === 0)("a read-only log falls back to the container log; the installer still runs", async () => {
		mkdirSync(join(dir, "home/.local/state/t3code"), { recursive: true });
		writeFileSync(log(), "earlier run\n", { mode: 0o444 });
		const { code, out, err } = await start();
		expect(code, err).toBe(0);
		expect(out).toContain("server started");
		expect(err).toContain("cannot write");
		expect(err).toContain("fake installer ran: --keep-trying");
		expect(readFileSync(log(), "utf8")).toBe("earlier run\n");
	});
});
