# Networking and Node tool footprint data (amd64)

Apt figures are dependency-inclusive metadata deltas against the original image, with recommends disabled; no candidate apt packages were installed during cost simulation. The separate packet-tool probe did install tcpdump/tshark in a disposable container. Group scenarios are not additive.

| Apt candidate/group | Installed delta (MiB) | Download (MiB) | Package changes |
| --- | ---: | ---: | ---: |
| tcpdump | 1.69 | 0.61 | 2 |
| tshark | 145.18 | 27.73 | 29 |
| wireshark-common | 144.75 | 27.56 | 28 |
| strongswan-swanctl | 1.95 | 0.61 | 2 |
| strongswan-pki | 3.00 | 0.88 | 4 |
| strongswan-charon | 7.59 | 2.27 | 10 |
| ike-scan | 4.17 | 0.99 | 1 |
| wireguard-tools | 0.31 | 0.08 | 1 |
| traceroute | 0.16 | 0.05 | 1 |
| mtr-tiny | 0.58 | 0.20 | 3 |
| iperf3 | 0.41 | 0.16 | 3 |
| ethtool | 0.80 | 0.23 | 2 |
| whois | 0.38 | 0.07 | 1 |
| conntrack | 0.35 | 0.10 | 4 |
| nftables | 1.69 | 0.53 | 6 |
| snmp | 9.87 | 4.70 | 6 |
| freeradius-utils | 4.02 | 0.99 | 7 |
| nmap | 27.71 | 6.52 | 6 |
| ipsec-peer | 9.77 | 2.91 | 14 |
| network-extension | 173.98 | 37.90 | 71 |
| routeros-network-baseline | 205.97 | 47.39 | 105 |

Node figures are actual fresh-prefix npm installs, including dependencies and platform binaries, excluding npm cache. Scripts were disabled and the installed commands were exercised. This differs from apt metadata and from an image-layer delta.

| Node package/group | Exact specification | Allocated (MiB) | Apparent (MiB) | Installed dependencies including roots |
| --- | --- | ---: | ---: | ---: |
| typescript | typescript@7.0.2 | 30.47 | 29.05 | 2 |
| cspell | cspell@10.4.0 | 13.88 | 9.51 | 108 |
| markdownlint-cli2 | markdownlint-cli2@0.24.0 | 16.77 | 12.88 | 89 |
| @biomejs/biome | @biomejs/biome@2.6.5 | 92.88 | 92.83 | 2 |
| combined-node-tools | typescript@7.0.2, cspell@10.4.0, markdownlint-cli2@0.24.0, @biomejs/biome@2.6.5 | 153.79 | 144.12 | 199 |
