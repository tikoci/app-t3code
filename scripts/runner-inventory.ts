import { mkdir } from "node:fs/promises";
import { readDebianPackages } from "../lib/image-inventory.ts";

// Capture the actual host's complete dpkg database as a complement to the
// selected tables published by actions/runner-images. Never dumps host env.
const output = process.argv[2] ?? "image-inventory/runner";
const packages = readDebianPackages();
await mkdir(output, { recursive: true });
await Bun.write(`${output}/inventory.json`, `${JSON.stringify({
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	osRelease: await Bun.file("/etc/os-release").text(),
	imageOS: process.env.ImageOS ?? null,
	imageVersion: process.env.ImageVersion ?? null,
	architecture: process.env.RUNNER_ARCH ?? process.arch,
	runId: process.env.GITHUB_RUN_ID ?? null,
	packages,
	note: "Actual CI host after setup-bun and image builds. Not an ARM64 runner inventory or a complete toolcache inventory.",
}, null, 2)}\n`);
await Bun.write(`${output}/packages.tsv`, "package\tversion\tarchitecture\tinstalled_size_kib\n" +
	packages.map((p) => [p.name, p.version, p.architecture, p.installedSizeKiB].join("\t")).join("\n") + "\n");
