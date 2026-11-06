# Built image inventory

Generated 2026-11-06T00:29:20.601Z; architecture: amd64.

227 installed Debian packages; 56/113 curated commands found on PATH.

- `inventory.json`: OS, package versions/sizes, PATH probes, runtime versions, global npm/Bun packages.
- `packages.tsv`: full installed Debian package list, including dependencies.
- `commands.tsv`: curated command availability; MISSING is explicit.

Image contents before entrypoint/first boot; Claude and browser downloads are excluded.

Commands are curated executable PATH probes, not an exhaustive list or functional tests; shims can need downloads.

Installed-Size is dpkg metadata in KiB, not compressed image size.

npm/Bun list top-level global packages; this is not a complete dependency SBOM.
