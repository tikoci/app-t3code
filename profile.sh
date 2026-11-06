# T3 Code login shells: volume-installed tools win over image tools.
# Tool-group shims follow the user's own installs; T3CODE_TOOLS_HOME moves
# the payload root (default /data/.local/share/t3code-tools).
export PATH="/data/.local/bin:/data/.bun/bin:${T3CODE_TOOLS_HOME:-/data/.local/share/t3code-tools}/bin:/opt/bun/bin:${PATH}"
