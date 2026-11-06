# Optional tool groups — review entrypoint

The approved design is consolidated in [REVIEW.md](REVIEW.md). It replaces
the earlier sequential proposals, including the initial Debian-cache/root
worker approach. Optional installed payloads belong under the existing
`/data` home where supported; the core remains stable, T3 starts before
downloads, and automatic image/security updates remain a requirement.
Native bundle feasibility is an open implementation review task.

The repository README and review brief define the groups. The
[research index](README.md) links the raw results and evidence appendices.
Tracking: [tool groups #5](https://github.com/tikoci/app-t3code/issues/5),
[automatic delivery #6](https://github.com/tikoci/app-t3code/issues/6).
