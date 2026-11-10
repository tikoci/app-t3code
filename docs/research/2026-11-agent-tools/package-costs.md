# Apt package cost estimates (amd64)

Independent simulations from the same local image; no candidate packages installed. Dependency-inclusive Installed-Size deltas and archive bytes from apt metadata, not actual OCI layer measurements. Groups are not additive.

| Candidate/scenario | Installed delta (MiB) | Apt download (MiB) | Package changes | Upgrades |
| --- | ---: | ---: | ---: | ---: |
| patch | 0.24 | 0.13 | 1 | 0 |
| file | 10.23 | 0.47 | 3 | 0 |
| bzip2 | 0.11 | 0.04 | 1 | 0 |
| xz-utils | 1.39 | 0.63 | 1 | 0 |
| zip | 0.61 | 0.22 | 1 | 0 |
| zstd | 2.27 | 0.72 | 1 | 0 |
| wget | 3.70 | 0.94 | 1 | 0 |
| rsync | 1.17 | 0.52 | 2 | 0 |
| tree | 0.13 | 0.06 | 1 | 0 |
| time | 0.13 | 0.05 | 1 | 0 |
| python-is-python3 | 0.02 | 0.00 | 1 | 0 |
| iproute2 | 4.22 | 1.21 | 6 | 0 |
| iputils-ping | 0.18 | 0.05 | 1 | 0 |
| bind9-dnsutils | 6.13 | 2.04 | 11 | 0 |
| netcat-openbsd | 0.11 | 0.04 | 1 | 0 |
| socat | 1.87 | 0.46 | 2 | 0 |
| sqlite3 | 0.57 | 0.37 | 1 | 0 |
| xxd | 0.15 | 0.09 | 1 | 0 |
| bsdextrautils | 0.33 | 0.09 | 1 | 0 |
| shellcheck | 33.97 | 4.68 | 1 | 0 |
| shfmt | 2.79 | 0.98 | 1 | 0 |
| gh | 33.85 | 7.26 | 1 | 0 |
| git-lfs | 12.31 | 3.75 | 1 | 0 |
| gnupg | 12.55 | 3.90 | 13 | 0 |
| sudo | 6.66 | 2.03 | 2 | 0 |
| locales | 20.03 | 4.46 | 2 | 0 |
| python3-venv | 2.82 | 2.65 | 4 | 0 |
| python3-pip | 10.27 | 1.46 | 3 | 0 |
| pipx | 7.39 | 3.65 | 10 | 0 |
| build-essential | 269.92 | 71.08 | 46 | 0 |
| pkg-config | 0.27 | 0.10 | 4 | 0 |
| cmake | 53.33 | 14.26 | 6 | 0 |
| ninja-build | 0.39 | 0.14 | 1 | 0 |
| autoconf | 2.81 | 0.75 | 2 | 0 |
| automake | 4.82 | 1.63 | 4 | 0 |
| libtool | 218.36 | 55.58 | 40 | 0 |
| yq | 1.18 | 0.30 | 6 | 0 |
| small-baseline | 19.98 | 3.78 | 14 | 0 |
| network-tools | 12.51 | 3.79 | 21 | 0 |
| inspection-lint | 37.81 | 6.21 | 5 | 0 |
| native-build | 270.19 | 71.18 | 50 | 0 |
| python-environments | 2.82 | 2.65 | 4 | 0 |
| recommended-baseline | 36.37 | 10.77 | 42 | 0 |
