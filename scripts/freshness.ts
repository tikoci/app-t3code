// Freshness checks: drift between this repo and the things it copies or pins
// fails a build instead of waiting for a reviewer to notice.
//
//   bun scripts/freshness.ts share-link [--write]   README share link vs app/t3code.tikapp.yaml (offline)
//   bun scripts/freshness.ts pinned [--version X]   the pinned T3 release (CI on every PR)
//   bun scripts/freshness.ts upstream [--version X] the newest stable T3 release (scheduled)
//   bun scripts/freshness.ts claude                 Claude Code's download contract (scheduled)
//
// The version defaults to package.json's; CI passes the T3CODE_VER it builds,
// which a workflow_dispatch can override.
// `pinned` checks that T3CODE_VER is a published stable T3
// release with both Linux archives, and that its harness catalog matches
// scripts/harnesses.ts. `upstream` checks that no newer stable release exists,
// and previews the newest release's harness catalog so a bump PR knows what it
// has to classify. `claude` checks that Anthropic's stable channel, manifest
// and binaries still have the shape bin/install-claude-code reads (a 404 and a
// changed manifest schema left every new home without Claude until #13).
// Network checks read GitHub; set GH_TOKEN or GITHUB_TOKEN to avoid the
// anonymous API rate limit.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { HARNESSES } from "./harnesses.ts";

const ROOT = join(import.meta.dir, "..");
export const UPSTREAM_REPO = "pingdotgg/t3code";
export const DRIVERS_PATH = "apps/server/src/provider/builtInDrivers.ts";
export const SHARE_LINK_BASE = "https://tikoci.dev/restraml/tikapp.html";
/** The Dockerfile downloads `t3-<ver>-linux-<arch>.tar.gz` for these arches. */
export const LINUX_ARCHES = ["x64", "arm64"] as const;

// --- share link -----------------------------------------------------------

const SHARE_LINK_RE = /\]\((https:\/\/tikoci\.dev\/restraml\/tikapp\.html\?[^)\s]+)\)/g;

/** Every /app YAML Editor link in a Markdown document. */
export function shareLinks(markdown: string): string[] {
	return [...markdown.matchAll(SHARE_LINK_RE)].map((m) => m[1] as string);
}

/** The editor link that embeds `yaml`, encoded the way the README carries it. */
export function renderShareLink(yaml: string): string {
	const params = new URLSearchParams();
	params.set("version", "latest");
	params.set("yaml", yaml);
	return `${SHARE_LINK_BASE}?${params}`;
}

// --- harness catalog --------------------------------------------------------

/**
 * Export names in upstream's `BUILT_IN_DRIVERS` array, in order, read from
 * TypeScript's syntax tree (no regexes: comments, strings and templates can't
 * pass for code). Strict on purpose: the name must occur once in the file, as
 * a top-level `export const BUILT_IN_DRIVERS = [Name, …]` whose initializer is
 * the bare array literal and whose entries are all identifiers. Anything else
 * (a `.concat`, a filter, `as`/`satisfies`, a spread, a hole, a push, a
 * second declaration, a syntax error) throws, so a catalog change can't pass
 * unseen.
 */
export function parseBuiltInDrivers(source: string): string[] {
	const fail = (why: string): never => {
		throw new Error(`${DRIVERS_PATH}: ${why}; upstream changed it, so update parseBuiltInDrivers`);
	};
	const file = ts.createSourceFile(DRIVERS_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const syntaxErrors = (file as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
	if (syntaxErrors.length) fail(`syntax error: ${ts.flattenDiagnosticMessageText(syntaxErrors[0]?.messageText ?? "", " ")}`);
	const uses: ts.Identifier[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && node.text === "BUILT_IN_DRIVERS") uses.push(node);
		ts.forEachChild(node, visit);
	};
	visit(file);
	if (uses.length !== 1) fail(uses.length ? `BUILT_IN_DRIVERS occurs ${uses.length} times, not just its declaration` : "no BUILT_IN_DRIVERS");
	const decl = (uses[0] as ts.Identifier).parent;
	const list = decl.parent;
	const statement = list?.parent;
	if (
		!ts.isVariableDeclaration(decl) ||
		!ts.isVariableDeclarationList(list) ||
		!(list.flags & ts.NodeFlags.Const) ||
		!statement ||
		!ts.isVariableStatement(statement) ||
		statement.parent !== file ||
		!statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
	) {
		return fail("BUILT_IN_DRIVERS is no longer a top-level `export const`");
	}
	const init = decl.initializer;
	if (!init || !ts.isArrayLiteralExpression(init)) return fail("BUILT_IN_DRIVERS is no longer a plain array literal");
	if (!init.elements.length) fail("BUILT_IN_DRIVERS is empty");
	const names = init.elements.map((element) =>
		ts.isIdentifier(element) ? element.text : fail(`BUILT_IN_DRIVERS has a ${ts.SyntaxKind[element.kind]} entry, not a plain name`),
	);
	const dupes = names.filter((name, i) => names.indexOf(name) !== i);
	if (dupes.length) fail(`BUILT_IN_DRIVERS lists ${[...new Set(dupes)].join(", ")} more than once`);
	return names;
}

export interface CatalogDiff {
	added: string[];
	removed: string[];
}

/** Drivers upstream has that we have not classified, and the reverse. */
export function diffCatalog(upstream: readonly string[], ours: readonly string[] = Object.keys(HARNESSES)): CatalogDiff {
	return {
		added: upstream.filter((name) => !ours.includes(name)),
		removed: ours.filter((name) => !upstream.includes(name)),
	};
}

// --- Claude Code downloads -------------------------------------------------

/** Where bin/install-claude-code downloads Claude Code (a test ties the script to it). */
export const CLAUDE_RELEASES_URL = "https://downloads.claude.ai/claude-code-releases";
/** Manifest platforms bin/install-claude-code installs: one per image arch (glibc). */
export const CLAUDE_PLATFORMS = ["linux-x64", "linux-arm64"] as const;
const CLAUDE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface ClaudeAsset {
	checksum: string;
	size: number;
}

/**
 * Read `<ver>/manifest.json` the way bin/install-claude-code does:
 * `.platforms[<platform>]` with a 64-hex `checksum` and a positive `size`.
 * Returns each platform's asset, or why the installer could not use it.
 */
export function claudeManifestAssets(manifest: unknown, version: string): { assets: Record<string, ClaudeAsset>; problems: string[] } {
	const assets: Record<string, ClaudeAsset> = {};
	const problems: string[] = [];
	const m = (manifest ?? {}) as { version?: unknown; platforms?: unknown };
	if (m.version !== undefined && m.version !== version) problems.push(`says version ${String(m.version)}, not ${version}`);
	const platforms = m.platforms;
	if (typeof platforms !== "object" || platforms === null) return { assets, problems: [...problems, "has no .platforms object"] };
	for (const platform of CLAUDE_PLATFORMS) {
		const entry = (platforms as Record<string, { checksum?: unknown; size?: unknown } | undefined>)[platform];
		const { checksum, size: raw } = entry ?? {};
		// The installer reads the size through `jq -r`, so "123" works as well as 123.
		const size = typeof raw === "string" && /^[1-9]\d*$/.test(raw) ? Number(raw) : raw;
		if (typeof checksum === "string" && /^[a-f0-9]{64}$/.test(checksum) && typeof size === "number" && Number.isSafeInteger(size) && size > 0) {
			assets[platform] = { checksum, size };
		} else {
			problems.push(`has no .platforms["${platform}"] {checksum, size}`);
		}
	}
	return { assets, problems };
}

// --- releases ---------------------------------------------------------------

export interface Release {
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
	assets: Array<{ name: string }>;
}

/** `X.Y.Z` from a plain `vX.Y.Z` tag; undefined for nightlies and anything else. */
export function stableVersion(tag: string): string | undefined {
	return tag.match(/^v(\d+\.\d+\.\d+)$/)?.[1];
}

const STABLE = /^\d+\.\d+\.\d+$/;

/** Order two stable `X.Y.Z` versions numerically; throws on anything else (a nightly has no place in this order). */
export function compareVersions(a: string, b: string): number {
	for (const v of [a, b]) if (!STABLE.test(v)) throw new Error(`${v} is not a stable X.Y.Z version`);
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) return Math.sign(d);
	}
	return 0;
}

/** Stable versions among git tag refs (`refs/tags/vX.Y.Z`), newest first. */
export function stableTagVersions(refs: ReadonlyArray<{ ref: string }>): string[] {
	return refs
		.map(({ ref }) => stableVersion(ref.replace(/^refs\/tags\//, "")))
		.filter((v): v is string => v !== undefined)
		.sort((a, b) => compareVersions(b, a));
}

/** Why a release cannot be the image's T3CODE_VER, or [] if it can. */
export function releaseProblems(release: Release, version: string): string[] {
	const problems: string[] = [];
	if (release.draft) problems.push("is a draft");
	if (release.prerelease) problems.push("is a prerelease");
	const tagVersion = stableVersion(release.tag_name);
	if (tagVersion === undefined) problems.push(`has tag ${release.tag_name}, not a stable vX.Y.Z`);
	else if (tagVersion !== version) problems.push(`has tag ${release.tag_name}, not v${version}`);
	const names = new Set(release.assets.map((a) => a.name));
	for (const arch of LINUX_ARCHES) {
		const archive = `t3-${version}-linux-${arch}.tar.gz`;
		if (!names.has(archive)) problems.push(`has no ${archive}`);
	}
	if (!names.has("SHA256SUMS")) problems.push("has no SHA256SUMS");
	return problems;
}

// --- network ----------------------------------------------------------------

/** A 404 from GitHub: the tag, release or file does not exist (no retry). */
export class NotFound extends Error {}

/** GET (or HEAD) with three tries and a 30 s timeout per try; a 404 throws NotFound at once. */
async function fetchOk(url: string, headers: Record<string, string> = {}, method: "GET" | "HEAD" = "GET"): Promise<Response> {
	let last = "";
	for (let attempt = 1; attempt <= 3; attempt++) {
		if (attempt > 1) await Bun.sleep(2000 * attempt);
		let res: Response;
		try {
			res = await fetch(url, { method, headers, signal: AbortSignal.timeout(30_000) });
		} catch (error) {
			last = String(error);
			continue;
		}
		if (res.ok) return res;
		// A missing tag or file will not appear on retry.
		if (res.status === 404) throw new NotFound(`${url}: HTTP 404 (no such release or file upstream)`);
		last = `HTTP ${res.status}`;
	}
	throw new Error(`${url}: ${last}`);
}

/** GitHub API headers, with GH_TOKEN or GITHUB_TOKEN when set (the anonymous limit is 60 requests an hour). */
function apiHeaders(): Record<string, string> {
	const token = process.env["GH_TOKEN"] || process.env["GITHUB_TOKEN"];
	return {
		Accept: "application/vnd.github+json",
		"User-Agent": "tikoci-app-t3code-freshness",
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};
}

/** One upstream release: `tags/vX.Y.Z`. */
async function release(path: string): Promise<Release> {
	const res = await fetchOk(`https://api.github.com/repos/${UPSTREAM_REPO}/releases/${path}`, apiHeaders());
	return (await res.json()) as Release;
}

/** Every upstream tag ref; GitHub returns them all in one unpaginated response. */
async function upstreamTags(): Promise<Array<{ ref: string }>> {
	const res = await fetchOk(`https://api.github.com/repos/${UPSTREAM_REPO}/git/matching-refs/tags/v`, apiHeaders());
	return (await res.json()) as Array<{ ref: string }>;
}

/** The driver list in upstream's builtInDrivers.ts at `tag`. */
async function upstreamDrivers(tag: string): Promise<string[]> {
	const res = await fetchOk(`https://raw.githubusercontent.com/${UPSTREAM_REPO}/${tag}/${DRIVERS_PATH}`);
	return parseBuiltInDrivers(await res.text());
}

// --- checks -----------------------------------------------------------------

/** T3CODE_VER as package.json carries it (the "release sync" test ties every other pin to it). */
export function pinnedVersion(): string {
	return (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
}

type Report = { ok: boolean; lines: string[] };

/** Compare one upstream driver list with scripts/harnesses.ts. */
function catalogReport(tag: string, upstream: string[]): Report {
	const { added, removed } = diffCatalog(upstream);
	if (!added.length && !removed.length) return { ok: true, lines: [`harness catalog at ${tag}: ${upstream.length} drivers, all in scripts/harnesses.ts`] };
	const lines = [`harness catalog at ${tag} differs from scripts/harnesses.ts (${DRIVERS_PATH}):`];
	if (added.length) lines.push(`  new upstream, classify each in HARNESSES: ${added.join(", ")}`);
	if (removed.length) lines.push(`  gone upstream, remove from HARNESSES (and any delivery): ${removed.join(", ")}`);
	return { ok: false, lines };
}

/** Replace the one Markdown /app YAML Editor link's URL, not any bare copy of it elsewhere. */
export function rewriteShareLink(readme: string, fresh: string): string {
	const links = shareLinks(readme);
	if (links.length !== 1) throw new Error(`README.md has ${links.length} /app YAML Editor links; expected exactly 1`);
	return readme.replace(`](${links[0]})`, () => `](${fresh})`);
}

/** The README share link embeds app/t3code.tikapp.yaml exactly; `write` regenerates it. */
export function checkShareLink(write = false): Report {
	const readmePath = join(ROOT, "README.md");
	const readme = readFileSync(readmePath, "utf8");
	const yaml = readFileSync(join(ROOT, "app/t3code.tikapp.yaml"), "utf8");
	const links = shareLinks(readme);
	if (links.length !== 1) return { ok: false, lines: [`README.md has ${links.length} /app YAML Editor links; expected exactly 1`] };
	const current = links[0] as string;
	const fresh = renderShareLink(yaml);
	if (current === fresh) return { ok: true, lines: ["README share link matches app/t3code.tikapp.yaml"] };
	if (write) {
		writeFileSync(readmePath, rewriteShareLink(readme, fresh));
		return { ok: true, lines: ["README share link regenerated from app/t3code.tikapp.yaml"] };
	}
	return { ok: false, lines: ["README share link is stale against app/t3code.tikapp.yaml; run `make share-link`"] };
}

/** `version` is a published stable release with both Linux archives, and its driver list matches ours. */
export async function checkPinned(version = pinnedVersion()): Promise<Report> {
	const tag = `v${version}`;
	const lines: string[] = [];
	let ok = true;
	const problems = releaseProblems(await release(`tags/${tag}`), version);
	if (problems.length) {
		ok = false;
		lines.push(`T3CODE_VER ${version}: upstream ${tag} ${problems.join("; ")}`);
	} else {
		lines.push(`T3CODE_VER ${version}: a stable upstream release with both Linux archives`);
	}
	const catalog = catalogReport(tag, await upstreamDrivers(tag));
	return { ok: ok && catalog.ok, lines: [...lines, ...catalog.lines] };
}

/**
 * No stable T3 release is newer than `version`. Newest comes from every
 * upstream tag, not GitHub's "latest" flag; a newer tag counts once its
 * release is published and not a prerelease (until then it is a note).
 */
export async function checkUpstream(version = pinnedVersion()): Promise<Report> {
	if (!STABLE.test(version)) return { ok: false, lines: [`T3CODE_VER ${version} is not a stable X.Y.Z; the image tracks stable releases only`] };
	const tags = stableTagVersions(await upstreamTags());
	if (!tags.length) return { ok: false, lines: ["no stable vX.Y.Z tags upstream; check by hand"] };
	if (compareVersions(version, tags[0] as string) > 0) return { ok: false, lines: [`T3CODE_VER ${version} is ahead of upstream's newest stable tag v${tags[0]}; was a release pulled?`] };
	const notes: string[] = [];
	for (const newer of tags.filter((v) => compareVersions(v, version) > 0)) {
		let found: Release;
		try {
			found = await release(`tags/v${newer}`);
		} catch (error) {
			if (!(error instanceof NotFound)) throw error;
			notes.push(`  note: v${newer} is tagged but has no published release yet`);
			continue;
		}
		if (found.draft || found.prerelease) {
			notes.push(`  note: v${newer} is a ${found.draft ? "draft" : "prerelease"}`);
			continue;
		}
		const lines = [`T3 Code ${newer} is out; T3CODE_VER is ${version}. Bump every pin (test/app-yaml.test.ts "release sync" lists them) and the CHANGELOG.`, ...notes];
		const problems = releaseProblems(found, newer);
		if (problems.length) lines.push(`  note: v${newer} ${problems.join("; ")}`);
		const catalog = catalogReport(`v${newer}`, await upstreamDrivers(`v${newer}`));
		lines.push(...catalog.lines.map((line) => `  ${line}`));
		return { ok: false, lines };
	}
	return { ok: true, lines: [`T3CODE_VER ${version} is the newest stable T3 Code`, ...notes] };
}

/**
 * Claude Code's `channel` pointer names a version whose manifest has both
 * Linux platforms, and each binary answers with the manifest's size: what
 * bin/install-claude-code needs. HEAD only; nothing large is downloaded.
 */
export async function checkClaude(channel: "stable" | "latest" = "stable"): Promise<Report> {
	const version = (await (await fetchOk(`${CLAUDE_RELEASES_URL}/${channel}`)).text()).trim();
	if (!CLAUDE_VERSION.test(version)) return { ok: false, lines: [`Claude Code ${channel} channel returned "${version.slice(0, 60)}", not a version`] };
	const manifestUrl = `${CLAUDE_RELEASES_URL}/${version}/manifest.json`;
	// HTTP errors propagate as themselves; only a body that fails to parse is "not JSON".
	const response = await fetchOk(manifestUrl);
	let manifest: unknown;
	try {
		manifest = await response.json();
	} catch (error) {
		return { ok: false, lines: [`${manifestUrl} is not JSON: ${error instanceof Error ? error.message : String(error)}`] };
	}
	const { assets, problems } = claudeManifestAssets(manifest, version);
	const unchecked: string[] = [];
	for (const [platform, { size }] of Object.entries(assets)) {
		const url = `${CLAUDE_RELEASES_URL}/${version}/${platform}/claude`;
		// identity: a compressed representation would report its own length.
		const header = (await fetchOk(url, { "Accept-Encoding": "identity" }, "HEAD")).headers.get("content-length");
		if (header === null || !/^\d+$/.test(header)) unchecked.push(platform);
		else if (Number(header) !== size) problems.push(`${platform}/claude is ${header} bytes, but the manifest says ${size}`);
	}
	if (problems.length) {
		return { ok: false, lines: [`Claude Code ${channel} ${version}: ${manifestUrl} ${problems.join("; ")}; update bin/install-claude-code`] };
	}
	const lines = [`Claude Code ${channel} ${version}: manifest and ${CLAUDE_PLATFORMS.join(" + ")} binaries match bin/install-claude-code`];
	if (unchecked.length) lines.push(`  note: no Content-Length for ${unchecked.join(" + ")}/claude; size not checked (the installer still verifies size and SHA-256)`);
	return { ok: true, lines };
}

/** Print a report; in Actions a failure is also an error annotation. */
function print(report: Report): void {
	const annotate = process.env["GITHUB_ACTIONS"] === "true" && !report.ok;
	console.log(annotate ? `::error title=freshness::${report.lines.join("%0A")}` : report.lines.join("\n"));
}

/** Run one check; an exception (network, parse) becomes a failed report. */
async function guarded(check: () => Report | Promise<Report>): Promise<Report> {
	try {
		return await check();
	} catch (error) {
		return { ok: false, lines: [error instanceof Error ? error.message : String(error)] };
	}
}

/** `--version X` / `--version=X`, else package.json's version. */
export function versionArg(args: string[]): string {
	const i = args.findIndex((arg) => arg === "--version" || arg.startsWith("--version="));
	if (i < 0) return pinnedVersion();
	const value = args[i]?.includes("=") ? args[i]?.slice("--version=".length) : args[i + 1];
	if (!value || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(value)) throw new Error(`--version needs a T3 version like 0.1.7, got ${value ?? "nothing"}`);
	return value;
}

const CHECKS: Record<string, (args: string[]) => Array<() => Report | Promise<Report>>> = {
	"share-link": (args) => [() => checkShareLink(args.includes("--write"))],
	pinned: (args) => [() => checkPinned(versionArg(args))],
	upstream: (args) => [() => checkUpstream(versionArg(args))],
	claude: () => [() => checkClaude()],
	all: (args) => [() => checkShareLink(), () => checkPinned(versionArg(args)), () => checkUpstream(versionArg(args)), () => checkClaude()],
};

/** CLI entry: exit 0 when every check passes, 1 on drift or error, 2 on usage. */
export async function main(argv: string[]): Promise<number> {
	const [command = "", ...args] = argv;
	const checks = Object.hasOwn(CHECKS, command) ? CHECKS[command] : undefined;
	if (!checks) {
		console.error("usage: bun scripts/freshness.ts share-link [--write] | pinned | upstream | claude | all  [--version X]");
		return 2;
	}
	let ok = true;
	for (const check of checks(args)) {
		const report = await guarded(check);
		print(report);
		ok &&= report.ok;
	}
	return ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
