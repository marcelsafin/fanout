#!/usr/bin/env bash
# Ollama backend. Usage:
#   WORKFLOW_AGENT_CMD=adapters/ollama.sh node engine.mjs run wf.mjs
# Model via WORKFLOW_OLLAMA_MODEL (default qwen2.5-coder:14b).
set -euo pipefail
exec ollama run "${WORKFLOW_OLLAMA_MODEL:-qwen2.5-coder:14b}" "$1"
