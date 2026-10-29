#!/usr/bin/env bash
# Convenient launcher for Outreach CLI ensuring Node runtime is in PATH
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$SCRIPT_DIR/node_runtime/bin:$HOME/.local/bin:$PATH"
exec node "$SCRIPT_DIR/main.js" "$@"
