#!/usr/bin/env bash
# opencode backend (subagents get opencode's tools; model is whatever
# opencode is configured with, including local open-source models).
# Usage:
#   WORKFLOW_AGENT_CMD=adapters/opencode.sh node engine.mjs run wf.mjs
# Model via WORKFLOW_OPENCODE_MODEL (optional, provider/model format).
set -euo pipefail
args=(run "$1")
[ -n "${WORKFLOW_OPENCODE_MODEL:-}" ] && args+=(--model "$WORKFLOW_OPENCODE_MODEL")
exec opencode "${args[@]}"
