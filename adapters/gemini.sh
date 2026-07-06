#!/usr/bin/env bash
# Gemini CLI backend.
# Usage:
#   WORKFLOW_AGENT_CMD=adapters/gemini.sh node engine.mjs run wf.mjs
# Model via WORKFLOW_GEMINI_MODEL (optional).
set -euo pipefail
args=(-p "$1")
[ -n "${WORKFLOW_GEMINI_MODEL:-}" ] && args+=(-m "$WORKFLOW_GEMINI_MODEL")
exec gemini "${args[@]}"
