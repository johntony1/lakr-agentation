#!/bin/sh
# Lakr Agentation for Codex: copies the server next to your Codex config, registers it as the "lakr" MCP server,
# and installs the skill. Re-run to update. Usage: sh install.sh   (from this folder, inside the Lakr Agentation dist)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
src="$here/../plugins/lakr-agentation"
[ -d "$src/server" ] || { echo "Run this from the Lakr Agentation dist (codex/ next to plugins/)."; exit 1; }
command -v node >/dev/null || { echo "Lakr Agentation needs Node 22+ (https://nodejs.org)."; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || { echo "Lakr Agentation needs Node 22+ (this is $(node -v))."; exit 1; }

dest="${LAKR_HOME:-$HOME/.lakr}/agentation"
rm -rf "$dest.new" && mkdir -p "$dest.new"
cp -R "$src/." "$dest.new/"
rm -rf "$dest" && mv "$dest.new" "$dest"

skills="$HOME/.agents/skills/lakr-agentation"
mkdir -p "$skills" && cp "$here/SKILL.md" "$skills/SKILL.md"

conf="${CODEX_HOME:-$HOME/.codex}/config.toml"
mkdir -p "$(dirname "$conf")" && touch "$conf"
# replace any earlier [mcp_servers.lakr] block (and its sub-tables) with the current one
awk 'BEGIN{skip=0} /^\[mcp_servers\.lakr(\]|\.)/{skip=1; next} /^\[/{skip=0} !skip' "$conf" > "$conf.tmp" && mv "$conf.tmp" "$conf"
cat >> "$conf" <<EOF

[mcp_servers.lakr]
command = "node"
args = ["$dest/server/server.mjs"]
env_vars = ["LAKR_TOKEN"]
startup_timeout_sec = 20
tool_timeout_sec = 600
EOF

echo "Lakr Agentation 0.1.3 installed for Codex:"
echo "  server  $dest"
echo "  skill   $skills/SKILL.md"
echo "  config  $conf  ([mcp_servers.lakr])"
echo "Films are made in ./lakr-films of the project you run Codex in. Optional: copy $here/AGENTS.md into a project."
