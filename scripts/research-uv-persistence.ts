// Standalone uv + Python tool persistence proof. Only a disposable home volume
// is changed; the existing image and its root filesystem stay read-only.
import { randomUUID } from "node:crypto";
const image = process.env.APP_T3CODE_DOCKER_IMAGE ?? "app-t3code:agent-tools";
const version = "0.13.7";
const assets = {
	x64: { target: "x86_64-unknown-linux-gnu", sha256: "c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83" },
	arm64: { target: "aarch64-unknown-linux-gnu", sha256: "71279f8d3c67241e807b9d8db872d1bf541579fb9f08b7d1eb1682196d1e57dc" },
};
function run(args: string[]) {
	const p = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: 180_000,
		env: { ...process.env, UV_PYTHON_DOWNLOADS: "never", NO_COLOR: "1", LC_ALL: "C" } });
	if (p.exitCode !== 0) throw new Error(`${args[0]} (${p.exitCode}): ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

if (process.argv[2] === "--inside") {
	const install = process.argv[3] === "install";
	const asset = assets[process.arch as keyof typeof assets];
	if (!asset) throw new Error(`Unsupported ${process.arch}`);
	const bin = "/data/.local/bin";
	const archiveUrl = `https://github.com/astral-sh/uv/releases/download/${version}/uv-${asset.target}.tar.gz`;
	let archiveBytes: number | null = null;
	if (install) {
		const response = await fetch(archiveUrl);
		if (!response.ok) throw new Error(`uv release fetch: ${response.status}`);
		const archive = new Uint8Array(await response.arrayBuffer());
		archiveBytes = archive.byteLength;
		if (new Bun.CryptoHasher("sha256").update(archive).digest("hex") !== asset.sha256) throw new Error("uv checksum mismatch");
		await Bun.write("/tmp/uv.tar.gz", archive);
		run(["mkdir", "-p", bin]);
		run(["tar", "-xzf", "/tmp/uv.tar.gz", "--strip-components=1", "-C", bin,
			`uv-${asset.target}/uv`, `uv-${asset.target}/uvx`]);
		run([`${bin}/uv`, "venv", "--python", "/usr/bin/python3", "/data/projects/uv-runtime-proof/.venv"]);
		run([`${bin}/uv`, "tool", "install", "--python", "/usr/bin/python3", "yamllint==1.38.0"]);
		run([`${bin}/uvx`, "--from", "yamllint==1.38.0", "yamllint", "--version"]);
	}
	const uv = `${bin}/uv`;
	console.log(JSON.stringify({ phase: install ? "install" : "replacement-offline", version, archiveUrl,
		sha256: asset.sha256, archiveBytes, uv: run([uv, "--version"]),
		uvx: run([`${bin}/uvx`, "--version"]),
		offlineUvx: run([`${bin}/uvx`, "--offline", "--from", "yamllint==1.38.0", "yamllint", "--version"]),
		installedTool: run([`${bin}/yamllint`, "--version"]),
		venvPython: run(["/data/projects/uv-runtime-proof/.venv/bin/python", "--version"]),
		cacheDir: run([uv, "cache", "dir"]), toolDir: run([uv, "tool", "dir"]),
		binaryBytes: ["uv", "uvx"].map((name) => ({ name, bytes: Bun.file(`${bin}/${name}`).size })),
		managedPythonDownloads: "never" }));
} else {
	const volume = `app-t3code-uv-research-${randomUUID()}`;
	const imageId = run(["docker", "image", "inspect", "--format", "{{.Id}}", image]);
	run(["docker", "volume", "create", volume]);
	try {
		const base = ["docker", "run", "--rm", "--read-only", "--tmpfs", "/tmp", "--volume", `${volume}:/data`,
			"--mount", `type=bind,src=${import.meta.path},dst=/tmp/research-uv.ts,readonly`,
			"--entrypoint", "bun"];
		const installed = JSON.parse(run([...base, image, "/tmp/research-uv.ts", "--inside", "install"]));
		const replaced = JSON.parse(run([...base, "--network", "none", image, "/tmp/research-uv.ts", "--inside", "verify"]));
		console.log(JSON.stringify({ generatedAt: new Date().toISOString(), image, imageId,
			method: "Two fresh containers from the same image with read-only root filesystems and the same home volume. First downloads verified standalone uv and installs a Python tool as node; second has no network and performs no installation. HOME data is removed after this research. No production image or Python runtime was changed.",
			installed, replaced }, null, 2));
	} finally {
		run(["docker", "volume", "rm", volume]);
	}
}
