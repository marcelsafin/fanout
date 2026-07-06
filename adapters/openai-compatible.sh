#!/usr/bin/env bash
# Any OpenAI-compatible endpoint — local or hosted. One adapter covers them all:
#   local:  llama.cpp, vLLM, LM Studio, LocalAI, Ollama, text-generation-webui
#   hosted: Kimi (https://api.moonshot.ai/v1), GLM (https://open.bigmodel.cn/api/paas/v4),
#           DeepSeek (https://api.deepseek.com/v1), OpenRouter (https://openrouter.ai/api/v1)
# Usage:
#   export WORKFLOW_OPENAI_BASE_URL=http://localhost:8080/v1
#   export WORKFLOW_OPENAI_MODEL=your-model
#   WORKFLOW_AGENT_CMD=adapters/openai-compatible.sh node engine.mjs run wf.mjs
# Optional: WORKFLOW_OPENAI_API_KEY (local servers usually ignore it, hosted ones need it).
set -euo pipefail
BASE="${WORKFLOW_OPENAI_BASE_URL:-http://localhost:11434/v1}"
MODEL="${WORKFLOW_OPENAI_MODEL:-qwen2.5-coder:14b}"
curl -sS "$BASE/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${WORKFLOW_OPENAI_API_KEY:-none}" \
  -d "$(jq -n --arg m "$MODEL" --arg p "$1" \
        '{model: $m, messages: [{role: "user", content: $p}]}')" \
  | jq -r '.choices[0].message.content'
