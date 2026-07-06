#!/usr/bin/env bash
# Stub backend for the test suite. Gets the full prompt as $1, prints the
# "agent reply" on stdout. Behavior keyed on markers embedded in the prompt.
set -e
PROMPT="$1"

case "$PROMPT" in
  *STUB_FAIL*)
    echo "boom" >&2; exit 1 ;;
  *STUB_FLAKY_JSON*)
    # First call: invalid output. Later calls: valid JSON. State via counter file.
    COUNTER="${STUB_STATE:-/tmp/stub-state}/flaky.count"
    mkdir -p "$(dirname "$COUNTER")"
    N=$(cat "$COUNTER" 2>/dev/null || echo 0)
    echo $((N + 1)) > "$COUNTER"
    if [ "$N" -eq 0 ]; then echo "sorry, no json here"; else echo '{"ok": true, "attempt": '"$N"'}'; fi ;;
  *STUB_JSON_BUGS*)
    echo '{"bugs": [{"desc": "b1"}, {"desc": "b2"}]}' ;;
  *STUB_MCP_FILE*)
    # Simulates a StructuredOutput tool call: result lands in the file, stdout is prose noise.
    echo '{"via":"tool","n":42}' > "$WORKFLOW_STRUCTURED_OUT"
    echo "some prose that is not json" ;;
  *STUB_SLEEP*)
    sleep 3; echo "slept" ;;
  *STUB_TOUCH*)
    echo dirty > touched.txt; echo "touched" ;;
  *STUB_COPILOT_EVENTS*)
    cat "$(cd "$(dirname "$0")" && pwd)/fixtures/copilot-events.jsonl" ;;
  *STUB_LONG*)
    head -c 400 /dev/zero | tr '\0' 'x' ;;
  *STUB_UPPER:*)
    WORD=$(printf '%s' "$PROMPT" | sed -n 's/.*STUB_UPPER:\([a-z]*\).*/\1/p')
    printf '%s' "$WORD" | tr '[:lower:]' '[:upper:]' ;;
  *)
    echo "ok" ;;
esac
