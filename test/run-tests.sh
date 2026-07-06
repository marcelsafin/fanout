#!/usr/bin/env bash
# Smoke suite for engine.mjs — runs entirely against the stub backend (no copilot calls).
set -uo pipefail
cd "$(dirname "$0")"
ENGINE=../engine.mjs
export WORKFLOW_AGENT_CMD="$PWD/stub-agent.sh"
export STUB_STATE="$(mktemp -d)"
RUNS="$(mktemp -d)"
PASS=0; FAIL=0

run() { node "$ENGINE" run "$1" --runs-dir "$RUNS" --max-concurrency 4 "${@:2}" 2>>steps.log; }

check() { # $1 = test name, $2 = JS predicate over parsed stdout JSON in `r`
  if node -e "
    const r = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    if (!($2)) { console.error(JSON.stringify(r, null, 2)); process.exit(1); }
  " <<< "$3"; then echo "ok   - $1"; PASS=$((PASS+1));
  else echo "FAIL - $1"; FAIL=$((FAIL+1)); fi
}

: > steps.log

OUT=$(run wf-smoke.mjs --args '{"x":1}')
check "pipeline no-barrier, stages get (prev,item,index)" \
  "r.ok && r.result.mapped.join()==='0:alpha->ALPHA,1:beta->BETA,2:gamma->GAMMA'" "$OUT"
check "parallel: throwing thunk and dead backend both -> null, call never rejects" \
  "r.result.par.length===3 && r.result.par[0]==='ok' && r.result.par[1]===null && r.result.par[2]===null" "$OUT"
check "Date.now()/Math.random() blocked, new Date(x) allowed, args passed verbatim" \
  "/unavailable/.test(r.result.dateErr) && /unavailable/.test(r.result.randErr) && r.result.okDate===true && r.result.args.x===1" "$OUT"

OUT=$(run wf-schema.mjs)
check "schema: invalid first reply -> validation retry -> parsed object" \
  "r.ok && r.result.res.ok===true && r.result.res.attempt>=1 && r.result.nBugs===2" "$OUT"

OUT=$(run wf-resume.mjs)
RID=$(node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).runId)" <<< "$OUT")
check "resume base run: 2 live agents" \
  "r.ok && r.agents.live===2 && r.agents.cached===0 && r.result.a==='FIRST' && r.result.b==='SECOND'" "$OUT"

OUT=$(run wf-resume.mjs --resume "$RID")
check "resume, unchanged script: 100% cache hit (0 live, 2 cached)" \
  "r.ok && r.agents.live===0 && r.agents.cached===2 && r.result.a==='FIRST' && r.result.b==='SECOND'" "$OUT"

sed 's/STUB_UPPER:second/STUB_UPPER:third/' wf-resume.mjs > "$STUB_STATE/wf-resume-edited.mjs"
OUT=$(run "$STUB_STATE/wf-resume-edited.mjs" --resume "$RID")
check "resume, edited 2nd call: prefix cached (1), rest live (1)" \
  "r.ok && r.agents.live===1 && r.agents.cached===1 && r.result.a==='FIRST' && r.result.b==='THIRD'" "$OUT"

OUT=$(run wf-budget.mjs --budget 50)
check "budget: hard ceiling — 2nd agent() throws after spend >= total" \
  "r.ok && r.result.firstLen===400 && r.result.spent===100 && r.result.total===50 && r.result.remaining===0 && /budget/.test(r.result.threw)" "$OUT"

OUT=$(run wf-parent.mjs)
check "workflow(): child runs inline, shares budget; 2-level nesting throws" \
  "r.ok && r.result.child.up==='HEJ' && /one level/.test(r.result.child.nestErr) && r.result.spentAfterChild>0" "$OUT"

OUT=$(run wf-caps.mjs)
check "caps: 4097 items into pipeline/parallel is an explicit error" \
  "r.ok && /4096/.test(r.result.pipeErr) && /4096/.test(r.result.parErr)" "$OUT"

OUT=$(WORKFLOW_STUB_FORMAT=json run wf-usage.mjs)
check "real copilot JSONL: text from assistant.message, tokens = summed data.outputTokens (109)" \
  "r.ok && /PONG/.test(r.result.text) && r.result.spent===109" "$OUT"

OUT=$(run wf-bad-meta.mjs)
check "meta must be a pure literal — identifier reference rejected" \
  "r.ok===false && /pure literal/.test(r.error)" "$OUT"

OUT=$(run wf-dup.mjs)
DUPRID=$(node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).runId)" <<< "$OUT")
OUT=$(run wf-dup.mjs --resume "$DUPRID")
check "occurrence-keyed cache: two identical prompts both replay on resume" \
  "r.ok && r.agents.cached===2 && r.agents.live===0 && r.result.a==='SAME' && r.result.b==='SAME'" "$OUT"

OUT=$(run wf-badschema.mjs)
check "unsupported schema keyword fails loud (patternProperties)" \
  "r.ok===false && /unsupported keyword/.test(r.error)" "$OUT"

if run wf-smoke.mjs --budget abc >/dev/null 2>&1; then
  echo "FAIL - --budget NaN must die, not silently disable"; FAIL=$((FAIL+1));
else
  echo "ok   - --budget NaN dies with explicit error"; PASS=$((PASS+1));
fi

OUT=$(run wf-structured.mjs)
check "schema: StructuredOutput file wins over prose stdout" \
  "r.ok && r.result.r.via==='tool' && r.result.r.n===42" "$OUT"

# StructuredOutput MCP server: raw JSON-RPC over stdio, no copilot involved.
MCPOUT="$STUB_STATE/mcp-out.json"; MCPSCHEMA="$STUB_STATE/mcp-schema.json"; MCPRESP="$STUB_STATE/mcp-resp.txt"
echo '{"type":"object","required":["x"]}' > "$MCPSCHEMA"
printf '%s\n%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"StructuredOutput","arguments":{"x":1}}}' \
  | WF_OUT="$MCPOUT" WF_SCHEMA="$MCPSCHEMA" node ../structured-output-mcp.mjs > "$MCPRESP"
if node -e "
  const fs=require('fs');
  const r='$MCPRESP', lines=fs.readFileSync(r,'utf8').trim().split('\n').map(JSON.parse);
  const init=lines.find(l=>l.id===1), list=lines.find(l=>l.id===2), call=lines.find(l=>l.id===3);
  if (init.result.protocolVersion!=='2025-06-18') process.exit(1);
  if (list.result.tools[0].name!=='StructuredOutput') process.exit(1);
  if (JSON.stringify(list.result.tools[0].inputSchema)!==fs.readFileSync('$MCPSCHEMA','utf8').trim()) process.exit(1);
  if (!call.result.content[0].text.includes('recorded')) process.exit(1);
  if (JSON.parse(fs.readFileSync('$MCPOUT','utf8')).x!==1) process.exit(1);
"; then echo "ok   - mcp server: initialize/tools_list/tools_call + outfile"; PASS=$((PASS+1));
else echo "FAIL - mcp server: initialize/tools_list/tools_call + outfile"; FAIL=$((FAIL+1)); fi

# Worktree isolation: needs a real git repo as cwd.
REPO="$(mktemp -d)"
git -C "$REPO" init -q && git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
OUT=$(node "$ENGINE" run "$PWD/wf-worktree.mjs" -C "$REPO" --runs-dir "$RUNS" --max-concurrency 4 2>>steps.log)
WTL=$(git -C "$REPO" worktree list | wc -l | tr -d ' ')
check "worktree: clean auto-removed, dirty kept (worktree list = 2)" \
  "r.ok && r.result.clean==='CLEAN' && r.result.dirty==='touched' && $WTL===2" "$OUT"

# SIGINT mid-run → aborted meta → resume replays journaled prefix from cache.
ABORT_RUNS="$(mktemp -d)"
node "$ENGINE" run "$PWD/wf-abort.mjs" --runs-dir "$ABORT_RUNS" --max-concurrency 4 > "$STUB_STATE/abort.out" 2>>steps.log &
ENGPID=$!
for i in $(seq 1 100); do
  RID=$(ls "$ABORT_RUNS" 2>/dev/null | head -1)
  [ -n "$RID" ] && [ -s "$ABORT_RUNS/$RID/journal.jsonl" ] && break
  sleep 0.1
done
kill -INT $ENGPID; wait $ENGPID 2>/dev/null
STATUS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ABORT_RUNS/$RID/meta.json','utf8')).status)")
OUT=$(node "$ENGINE" run "$PWD/wf-abort.mjs" --runs-dir "$ABORT_RUNS" --resume "$RID" --max-concurrency 4 2>>steps.log)
check "SIGINT: meta=aborted ($STATUS); resume: 1 cached + 1 live, result intact" \
  "'$STATUS'==='aborted' && r.ok && r.agents.cached===1 && r.agents.live===1 && r.result.a==='FIRST' && r.result.b==='slept'" "$OUT"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
