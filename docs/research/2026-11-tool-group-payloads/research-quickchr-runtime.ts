// Run as node inside a disposable image container. Boots real x86 and ARM64
// CHRs with the installed quickchr/QEMU, validates through centrs, then removes
// the machines. Generated credentials are never written to this report.
// QUICKCHR_MODULE (with QUICKCHR_PACKAGE_JSON) runs another quickchr build,
// e.g. a branch checkout mounted into the container (slice 5: quickchr#254).
const modulePath = process.env.QUICKCHR_MODULE ?? "@tikoci/quickchr";
const packageJson = process.env.QUICKCHR_PACKAGE_JSON ?? "/opt/bun/install/global/node_modules/@tikoci/quickchr/package.json";
const { QuickCHR }: typeof import("@tikoci/quickchr") = await import(modulePath);
const findings = [];
for (const arch of ["x86", "arm64"] as const) {
	const name = `deps-${arch}-${Date.now()}`;
	const began = Date.now();
	let instance: Awaited<ReturnType<typeof QuickCHR.start>> | undefined;
	try {
		instance = await QuickCHR.start({ name, arch, version: "7.25.1", mem: 512, cpu: 1,
			bootSize: "256M", bootDiskFormat: "qcow2", extraDisks: ["16M"],
			secureLogin: true, background: true, timeoutExtra: 120_000 });
		const command = ["centrs", "retrieve", "--quickchr", name, "/system/resource", "--json"];
		const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", timeout: 45_000 });
		if (result.exitCode !== 0) throw new Error(`centrs resource read failed (${result.exitCode})`);
		const envelope = JSON.parse(result.stdout.toString());
		if (envelope.ok !== true) throw new Error("centrs resource envelope not ok");
		const row = Array.isArray(envelope.data) ? envelope.data[0] : envelope.data;
		findings.push({ arch, elapsedMs: Date.now() - began, ready: true,
			version: row?.version ?? null, reportedArchitecture: row?.["architecture-name"] ?? null,
			qcow2BootAndExtraDisk: true, managedLoginProvisioned: true, centrsRead: true });
	} catch (error) {
		// Do not print quickchr failure reports: they can include provisioning data.
		// The error code (MISSING_FIRMWARE, BOOT_TIMEOUT…) names the failure without its details.
		const code = (error as { code?: unknown } | null)?.code;
		findings.push({ arch, elapsedMs: Date.now() - began, ready: false,
			errorName: error instanceof Error ? error.name : "unknown", ...(typeof code === "string" ? { errorCode: code } : {}) });
	} finally {
		const machine = instance ?? QuickCHR.get(name);
		if (machine) await machine.remove();
	}
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), quickchrVersion:
	(await Bun.file(packageJson).json()).version, quickchrModule: modulePath,
	method: "Disposable image container, node user, TCG (no KVM exposed), real CHR 7.25.1, managed login, qcow2 boot resize and extra disk, read-only centrs resource query. Test-only storage reserve reduced to 512M for the constrained research host. No production router or image was changed.",
	findings }, null, 2));
if (findings.some((f) => !f.ready)) process.exitCode = 1;
