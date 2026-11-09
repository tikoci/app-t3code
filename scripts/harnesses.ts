// Our view of T3 Code's harness (provider driver) catalog: one entry per
// driver in upstream `BUILT_IN_DRIVERS`
// (apps/server/src/provider/builtInDrivers.ts), keyed by its export name.
// `bun scripts/freshness.ts pinned` fails when the pinned T3 release's list
// differs from these keys, so a T3 bump that adds, renames or drops a driver
// cannot land without someone deciding how this image delivers it.
// scripts/providers.ts (T3CODE_PROVIDERS, issue #13) installs from this list.

/**
 * How a provider's runtime reaches the container.
 * - npm: `npm install -g` into the home (NPM_CONFIG_PREFIX=/data/.local), so
 *   T3's Update now recognizes it as an npm install and updates it there.
 * - script: the vendor's own installer, which installs into the home. Trust
 *   decision (owner, 2026-11-09): the vendor's HTTPS endpoint, exactly as
 *   their documented `curl | bash` and T3's own /welcome install; nothing is
 *   pinned, so the vendor's updater keeps working. Grok's script verifies no
 *   checksum; Muse's verifies its launcher when the server sends a digest.
 * - command: an installer this image ships (bin/install-claude-code).
 * - t3: T3 provides it: a library inside T3 (Cursor) or a runtime T3
 *   downloads into /data/.t3/tools from its own settings (Antigravity).
 */
export type Install =
	| { kind: "npm"; package: string; flags?: readonly string[] }
	| { kind: "script"; url: string; env?: Readonly<Record<string, string>> }
	| { kind: "command"; argv: readonly string[] }
	| { kind: "t3" };

export interface Harness {
	/** The T3CODE_PROVIDERS token; only the providers in T3's main Add provider list have one. */
	token?: string;
	/** The name T3's UI shows. */
	label: string;
	/** The CLI T3 looks for on PATH (absent when T3 provides the runtime itself). */
	cli?: string;
	install?: Install;
	/** Installed size in /data (amd64, measured 2026-11-09); the installer wants twice this free, plus a reserve. */
	approxMiB?: number;
	note?: string;
}

export const HARNESSES: Readonly<Record<string, Harness>> = {
	CodexDriver: {
		token: "codex",
		label: "Codex",
		cli: "codex",
		install: { kind: "npm", package: "@openai/codex" },
		approxMiB: 437,
		note: "T3's Continue with ChatGPT also downloads its own managed Codex into /data/.t3/tools/codex",
	},
	ClaudeDriver: { token: "claude", label: "Claude", cli: "claude", install: { kind: "command", argv: ["install-claude-code"] }, approxMiB: 280, note: "stable channel; Claude's own updater owns it afterwards" },
	CursorDriver: { token: "cursor", label: "Cursor", install: { kind: "t3" }, note: "Cursor's SDK ships inside T3; sign in from Settings → Providers" },
	GrokDriver: { token: "grok", label: "Grok", cli: "grok", install: { kind: "script", url: "https://x.ai/cli/install.sh" }, approxMiB: 192 },
	FxDriver: { label: "fx", note: "under Show more in T3; not installed by this image" },
	OpenCodeDriver: { token: "opencode", label: "OpenCode", cli: "opencode", install: { kind: "npm", package: "opencode-ai" }, approxMiB: 409 },
	AntigravityDriver: {
		token: "antigravity",
		label: "Antigravity",
		install: { kind: "t3" },
		note: "T3 downloads its runtime into /data/.t3/tools/antigravity-acp when you install it from Settings → Providers",
	},
	KiroDriver: { label: "Kiro", note: "under Show more in T3; not installed by this image" },
	PiDriver: { token: "pi", label: "Pi", cli: "pi", install: { kind: "npm", package: "@earendil-works/pi-coding-agent", flags: ["--ignore-scripts"] }, approxMiB: 152 },
	MuseDriver: {
		token: "muse",
		label: "Muse Code",
		cli: "muse",
		install: { kind: "script", url: "https://dev.meta.ai/install.sh", env: { MUSE_NO_MODIFY_PATH: "1" } },
		approxMiB: 396,
	},
	AcpRegistryDriver: { label: "ACP Registry", note: "under Show more in T3; each ACP agent is user-installed" },
};
