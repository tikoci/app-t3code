/**
 * End-to-end: boot a real CHR under QEMU, enable containers, install the
 * tikoci/app-t3code /app, and prove the T3 Code web UI answers.
 *
 * Gated: APP_T3CODE_INTEGRATION=1 (needs QEMU + network for image downloads).
 * CHR runs the free license here, so the GHCR pull of the ~1GB image can
 * take many minutes — the boot/install/probe budget below sizes from the
 * slow end (TCG) rather than the fast end (HVF/KVM).
 *
 * Knobs (all optional):
 *   APP_T3CODE_ROS      RouterOS version ("7.25") or channel ("stable")
 *   APP_T3CODE_ARCH     "x86" | "arm64" (default: host arch)
 *   APP_T3CODE_T3VER    expected T3 Code serverVersion (default: package.json version)
 *   APP_T3CODE_NAME     CHR machine name (default: per-arch fixed name)
 *   APP_T3CODE_KEEP=1   leave the CHR machine behind for inspection (default: removed)
 *
 * RouterOS is driven through centrs (@tikoci/centrs@next) — quickchr boots
 * the VM, centrs talks to it. The only non-centrs HTTP call is the final
 * probe of the T3 web UI itself, which is not RouterOS.
 *
 * Install flow (verified live on CHR 7.25 x86, 2026-11-02):
 *   1. first-boot deviceMode container (guest-side enable never completes)
 *   2. installPackage("container") — /app 404s without the package
 *   3. format an extra disk ext4 + /app/settings/set disk=... — enable
 *      refuses with "need to configure disk to install apps to" otherwise
 *   4. api PUT app {yaml, use-https=no} — CHR has no /ip/cloud on a free
 *      license, so use-https=yes could never mint certs here
 *   5. /app/set disabled=no — PUT leaves the app disabled:true
 *   6. poll /app + /container (.running is the string "true") + HTTP probe
 */
import { describe, expect, test, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QuickCHR } from "@tikoci/quickchr";

const SKIP = process.env["APP_T3CODE_INTEGRATION"] !== "1";

const ROS = process.env["APP_T3CODE_ROS"] ?? "stable";
const CHANNELS = new Set(["stable", "long-term", "testing", "development"]);
const ARCH = (process.env["APP_T3CODE_ARCH"] ?? (process.arch === "arm64" ? "arm64" : "x86")) as
	| "x86"
	| "arm64";
const NAME = process.env["APP_T3CODE_NAME"] ?? `app-t3code-${ARCH}-test`;
// NOTE: this file lives in test/integration/, so the repo root is two levels up.
const YAML_PATH = join(import.meta.dir, "..", "..", "app", "t3code.tikapp.yaml");
const KEEP = process.env["APP_T3CODE_KEEP"] === "1";

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as {
	version: string;
};
const EXPECTED_T3VER = process.env["APP_T3CODE_T3VER"] ?? pkg.version;

type Instance = Awaited<ReturnType<typeof QuickCHR.start>>;

let instance: Instance | undefined;

async function centrsJson(args: string[]): Promise<unknown> {
	const proc = Bun.spawn(["bunx", "@tikoci/centrs@next", ...args, "--json"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const payload = out.includes("{") ? out.slice(out.indexOf("{")) : err.slice(err.indexOf("{"));
	if (code !== 0 || !payload) {
		throw new Error(`centrs ${args.join(" ")} exited ${code}: ${(err || out).slice(0, 2000)}`);
	}
	return JSON.parse(payload) as unknown;
}

function envelopeData(env: unknown): Record<string, unknown>[] {
	const rec = env as { ok?: boolean; data?: unknown; meta?: { operation?: { objectCount?: number } } };
	if (rec.ok !== true) throw new Error(`centrs envelope not ok: ${JSON.stringify(env).slice(0, 500)}`);
	const count = rec.meta?.operation?.objectCount ?? -1;
	const data = rec.data;
	if (count === 0) return [];
	if (Array.isArray(data)) return data as Record<string, unknown>[];
	if (data !== null && typeof data === "object" && Object.keys(data).length > 0)
		return [data as Record<string, unknown>];
	return [];
}

async function cleanup(): Promise<void> {
	if (KEEP) {
		console.log(`[integration] APP_T3CODE_KEEP=1 — leaving ${NAME} for inspection`);
		return;
	}
	if (!instance) {
		try {
			instance = QuickCHR.get(NAME) as Instance | undefined;
		} catch {
			instance = undefined;
		}
	}
	if (instance) {
		try {
			await instance.stop();
		} catch {
			/* already stopped */
		}
		try {
			await instance.remove();
		} catch {
			/* already removed */
		}
		instance = undefined;
	}
}

afterAll(async () => {
	if (!SKIP) await cleanup();
});

describe.skipIf(SKIP)("app-t3code on CHR", () => {
	test(
		"container installs, runs, and serves the T3 web UI",
		async () => {
			const yaml = readFileSync(YAML_PATH, "utf8");

			try {
				// 1. Boot CHR with container device-mode at first boot
				//    (post-boot guest-side enable does not complete), an
				//    extra data disk for /app storage, and a host forward
				//    for the T3 web port. 8G system disk: the pulled image
				//    layers must not overflow the stock CHR disk.
				const rosOpts = CHANNELS.has(ROS) ? { channel: ROS } : { version: ROS };
				instance = await QuickCHR.start({
					...rosOpts,
					arch: ARCH,
					name: NAME,
					cpu: 1,
					mem: 1024,
					bootSize: "8G",
					bootDiskFormat: "qcow2",
					extraDisks: ["8G"],
					deviceMode: { enable: ["container"] },
					extraPorts: [{ name: "t3web", host: 0, guest: 3773, proto: "tcp" }],
					timeoutExtra: 240_000,
				} as Parameters<typeof QuickCHR.start>[0]);
				expect(instance.state.status).toBe("running");

				const ports = instance.ports as Record<string, number>;
				const t3HostPort = ports["t3web"];
				expect(t3HostPort).toBeGreaterThan(0);

				// 2. Install the container extra package (reboots the guest).
				await instance.installPackage("container");

				const pkgs = envelopeData(await centrsJson(["retrieve", "--quickchr", NAME, "/system/package"]));
				expect(pkgs.some((p) => p["name"] === "container")).toBe(true);

				// 3. Format the extra disk ext4 and point /app at it.
				const disks = envelopeData(await centrsJson(["retrieve", "--quickchr", NAME, "/disk"]));
				const blank = disks.find((d) => d["fs"] === "-");
				expect(blank).toBeDefined();
				await centrsJson([
					"execute",
					"--quickchr",
					NAME,
					"--yes",
					`/disk/format ${blank?.[".id"]} file-system=ext4`,
				]);
				const formatted = envelopeData(await centrsJson(["retrieve", "--quickchr", NAME, "/disk"]));
				const dataDisk = formatted.find((d) => d["fs"] === "ext4");
				expect(dataDisk).toBeDefined();
				const diskRef = (dataDisk?.["mount-point"] ?? dataDisk?.["slot"]) as string;
				await centrsJson([
					"execute",
					"--quickchr",
					NAME,
					"--yes",
					`/app/settings/set disk=${diskRef}`,
				]);

				// 4. Install the /app with HTTPS off: CHR has no /ip/cloud on
				//    a free license, so use-https=yes could never mint certs
				//    here. Production flips this flag to yes (see README).
				const added = (await centrsJson([
					"api",
					"--quickchr",
					NAME,
					"app",
					"-X",
					"PUT",
					"-f",
					`yaml=${yaml}`,
					"-f",
					"use-https=no",
					"--yes",
				])) as { ok?: boolean };
				expect(added.ok).toBe(true);

				// 5. PUT leaves the app disabled:true — enable it.
				await centrsJson([
					"execute",
					"--quickchr",
					NAME,
					"--yes",
					'/app/set [find where name="t3code"] disabled=no',
				]);

				// 6. Wait for the /app entry, then for the container to
				//    report running, then for the T3 web UI to answer with
				//    our version.
				const deadline = Date.now() + 20 * 60_000;
				let webOk = false;
				let lastState = "";
				while (Date.now() < deadline) {
					const apps = envelopeData(await centrsJson(["retrieve", "--quickchr", NAME, "/app"]));
					const ours = apps.filter((a) => a["name"] === "t3code");
					const containers = envelopeData(
						await centrsJson(["retrieve", "--quickchr", NAME, "/container"]),
					);
					lastState = `apps=${apps.length} ours=${ours.length} containers=${JSON.stringify(containers.map((c) => c["running"]))}`;
					const running = containers.some((c) => c["running"] === "true");
					if (ours.length > 0 && running) {
						try {
							const res = await fetch(`http://127.0.0.1:${t3HostPort}/.well-known/t3/environment`);
							if (res.ok) {
								const body = (await res.json()) as { serverVersion?: string };
								lastState += ` serverVersion=${body.serverVersion}`;
								if (body.serverVersion === EXPECTED_T3VER) {
									webOk = true;
									break;
								}
							} else {
								lastState += ` http=${res.status}`;
							}
						} catch (err) {
							lastState += ` fetch=${(err as Error).message.slice(0, 120)}`;
						}
					}
					await Bun.sleep(15_000);
				}
				console.log(`[integration] final: ${lastState}`);
				expect(webOk).toBe(true);
			} finally {
				await cleanup();
			}
		},
		30 * 60_000,
	);
});
