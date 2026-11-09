// Freshness checks: drift between this repo and the things it copies or pins
// fails a build instead of waiting for a reviewer to notice.
//
//   bun scripts/freshness.ts share-link [--write]   README share link vs app/t3code.tikapp.yaml (offline)
//   bun scripts/freshness.ts pinned [--version X]   the pinned T3 release (CI on every PR)
//   bun scripts/freshness.ts upstream [--version X] the newest stable T3 release (scheduled)
//
// The version defaults to package.json's; CI passes the T3CODE_VER it builds,
// which a workflow_dispatch can override.
// `pinned` checks that T3CODE_VER is a published stable T3
// release with both Linux archives, and that its harness catalog matches
// scripts/harnesses.ts. `upstream` checks that no newer stable release exists,
// and previews the newest release's harness catalog so a bump PR knows what it
// has to classify. Network checks read GitHub; set GH_TOKEN or GITHUB_TOKEN to
// avoid the anonymous API rate limit.

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
	return init.elements.map((element) =>
		ts.isIdentifier(element) ? element.text : fail(`BUILT_IN_DRIVERS has a ${ts.SyntaxKind[element.kind]} entry, not a plain name`),
	);
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

export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) return Math.sign(d);
	}
	return 0;
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

async function fetchOk(url: string, headers: Record<string, string> = {}): Promise<Response> {
	let last = "";
	for (let attempt = 1; attempt <= 3; attempt++) {
		if (attempt > 1) await Bun.sleep(2000 * attempt);
		let res: Response;
		try {
			res = await fetch(url, { headers });
		} catch (error) {
			last = String(error);
			continue;
		}
		if (res.ok) return res;
		// A missing tag or file will not appear on retry.
		if (res.status === 404) throw new Error(`${url}: HTTP 404 (no such release or file upstream)`);
		last = `HTTP ${res.status}`;
	}
	throw new Error(`${url}: ${last}`);
}

function apiHeaders(): Record<string, string> {
	const token = process.env["GH_TOKEN"] || process.env["GITHUB_TOKEN"];
	return {
		Accept: "application/vnd.github+json",
		"User-Agent": "tikoci-app-t3code-freshness",
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};
}

async function release(path: string): Promise<Release> {
	const res = await fetchOk(`https://api.github.com/repos/${UPSTREAM_REPO}/releases/${path}`, apiHeaders());
	return (await res.json()) as Release;
}

async function upstreamDrivers(tag: string): Promise<string[]> {
	const res = await fetchOk(`https://raw.githubusercontent.com/${UPSTREAM_REPO}/${tag}/${DRIVERS_PATH}`);
	return parseBuiltInDrivers(await res.text());
}

// --- checks -----------------------------------------------------------------

export function pinnedVersion(): string {
	return (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
}

type Report = { ok: boolean; lines: string[] };

function catalogReport(tag: string, upstream: string[]): Report {
	const { added, removed } = diffCatalog(upstream);
	if (!added.length && !removed.length) return { ok: true, lines: [`harness catalog at ${tag}: ${upstream.length} drivers, all in scripts/harnesses.ts`] };
	const lines = [`harness catalog at ${tag} differs from scripts/harnesses.ts (${DRIVERS_PATH}):`];
	if (added.length) lines.push(`  new upstream, classify each in HARNESSES: ${added.join(", ")}`);
	if (removed.length) lines.push(`  gone upstream, remove from HARNESSES (and any delivery): ${removed.join(", ")}`);
	return { ok: false, lines };
}

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
		writeFileSync(readmePath, readme.replace(current, () => fresh));
		return { ok: true, lines: ["README share link regenerated from app/t3code.tikapp.yaml"] };
	}
	return { ok: false, lines: ["README share link is stale against app/t3code.tikapp.yaml; run `make share-link`"] };
}

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

export async function checkUpstream(version = pinnedVersion()): Promise<Report> {
	const latest = await release("latest");
	const newest = stableVersion(latest.tag_name);
	if (!newest) return { ok: false, lines: [`upstream's latest release is ${latest.tag_name}, not a plain vX.Y.Z tag; check it by hand`] };
	const order = compareVersions(newest, version);
	if (order === 0) return { ok: true, lines: [`T3CODE_VER ${version} is the newest stable T3 Code`] };
	if (order < 0) return { ok: false, lines: [`T3CODE_VER ${version} is ahead of upstream's latest stable ${newest}; was a release pulled?`] };
	const lines = [`T3 Code ${newest} is out; T3CODE_VER is ${version}. Bump every pin (test/app-yaml.test.ts "release sync" lists them) and the CHANGELOG.`];
	const problems = releaseProblems(latest, newest);
	if (problems.length) lines.push(`  note: ${latest.tag_name} ${problems.join("; ")}`);
	const catalog = catalogReport(latest.tag_name, await upstreamDrivers(latest.tag_name));
	lines.push(...catalog.lines.map((line) => `  ${line}`));
	return { ok: false, lines };
}

function print(report: Report): void {
	// In Actions a failure is also an annotation, so it shows on the run page.
	const annotate = process.env["GITHUB_ACTIONS"] === "true" && !report.ok;
	console.log(annotate ? `::error title=freshness::${report.lines.join("%0A")}` : report.lines.join("\n"));
}

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
	all: (args) => [() => checkShareLink(), () => checkPinned(versionArg(args)), () => checkUpstream(versionArg(args))],
};

export async function main(argv: string[]): Promise<number> {
	const [command = "", ...args] = argv;
	const checks = CHECKS[command];
	if (!checks) {
		console.error("usage: bun scripts/freshness.ts share-link [--write] | pinned | upstream | all  [--version X]");
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
