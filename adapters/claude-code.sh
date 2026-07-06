#!/usr/bin/env bash
# Claude Code CLI backend (subagents get Claude Code's tools).
# Usage:
#   WORKFLOW_AGENT_CMD=adapters/claude-code.sh node engine.mjs run wf.mjs
# Model via WORKFLOW_CLAUDE_MODEL (optional).
set -euo pipefail
args=(-p "$1")
[ -n "${WORKFLOW_CLAUDE_MODEL:-}" ] && args+=(--model "$WORKFLOW_CLAUDE_MODEL")
exec claude "${args[@]}"
