// Our view of T3 Code's harness (provider driver) catalog: one entry per
// driver in upstream `BUILT_IN_DRIVERS`
// (apps/server/src/provider/builtInDrivers.ts), keyed by its export name.
// `bun scripts/freshness.ts pinned` fails when the pinned T3 release's list
// differs from these keys, so a T3 bump that adds, renames or drops a driver
// cannot land without someone deciding how this image delivers it. Issue #13
// builds per-harness selection on top of this list; until then a new driver
// is "not-bundled" unless a PR says otherwise.

/**
 * image: the CLI is baked into the image (a core check).
 * home: the image installs it into /data at startup.
 * not-bundled: T3 supports it; the user installs the CLI.
 */
export type HarnessDelivery = "image" | "home" | "not-bundled";

export interface Harness {
	/** The CLI name, where this repo installs it or documents installing it. */
	cli?: string;
	delivery: HarnessDelivery;
	note?: string;
}

export const HARNESSES: Readonly<Record<string, Harness>> = {
	CodexDriver: { cli: "codex", delivery: "image" },
	ClaudeDriver: { cli: "claude", delivery: "home", note: "install-claude-code, in the background at first start" },
	CursorDriver: { delivery: "not-bundled" },
	GrokDriver: { delivery: "not-bundled" },
	FxDriver: { delivery: "not-bundled" },
	OpenCodeDriver: { cli: "opencode", delivery: "image" },
	AntigravityDriver: { delivery: "not-bundled" },
	KiroDriver: { delivery: "not-bundled" },
	PiDriver: { delivery: "not-bundled" },
	MuseDriver: { cli: "muse", delivery: "not-bundled", note: "README documents Meta's installer into /data/.local/bin" },
	AcpRegistryDriver: { delivery: "not-bundled", note: "ACP registry agents; each one is user-installed" },
};
