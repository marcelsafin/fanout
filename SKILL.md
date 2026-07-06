---
name: workflows
description: >-
  Deterministic multi-agent workflow orchestration engine (1:1 port of Claude
  Code's Workflow tool) for GitHub Copilot CLI. Use ONLY when the user
  explicitly opts into multi-agent orchestration: says "workflow", "run a
  workflow", "fan out agents", "orchestrate with subagents", "ultracode", or
  invokes /workflows. Author a script with agent()/parallel()/pipeline()/
  phase()/log()/args/budget/workflow(), run it with engine.mjs, resume
  interrupted runs from the journal. Workflows can spawn dozens of agents and
  consume many premium requests — the user must request that scale, not have
  it inferred.
argument-hint: "[task to orchestrate | list | resume <runId>]"
user-invocable: true
---

# workflows — deterministic multi-agent orchestration

A workflow structures work across many agents — to be comprehensive (decompose
and cover in parallel), to be confident (independent perspectives and
adversarial checks before committing), or to take on scale one context can't
hold (migrations, audits, broad sweeps). The script encodes that structure:
what fans out, what verifies, what synthesizes.

**Engine:** `~/.copilot/skills/workflows/engine.mjs` (Node ≥ 18, zero deps).
Each `agent()` call spawns a `copilot -p` subagent.

## When to use

ONLY when the user has explicitly opted in: they said "use/run a workflow",
"fan out agents", "orchestrate this with subagents", "ultracode", or invoked
this skill directly. For any other task — even one that would clearly benefit
from parallelism — do NOT run a workflow; briefly describe what one could do
and ask. A task that would merely benefit from a workflow does not count as
opt-in.

The right move is often **hybrid**: scout inline first (list the files, scope
the diff, find the work-list), then orchestrate over it. You don't need to
know the shape before the *task* — only before the *orchestration step*.

## Running

```bash
node ~/.copilot/skills/workflows/engine.mjs run <script.mjs> \
  [--args '<json>' | --args @file.json]   # exposed verbatim as `args` in the script
  [--budget <tokens>]                     # hard token ceiling → `budget` in the script
  [--resume <runId>]                      # replay cached prefix, run the rest live
  [--model <m>] [--effort <level>]        # defaults for all agents (omit to inherit)
  [--max-concurrency <n>] [-C <dir>] [--runs-dir <dir>]

node ~/.copilot/skills/workflows/engine.mjs list              # all runs + status
node ~/.copilot/skills/workflows/engine.mjs journal <runId>   # each agent's actual return value
```

Final result prints as JSON on stdout (`{runId, ok, result, agents, tokens}`);
live progress streams on stderr. Write the script to a temp file, run it, read
the stdout JSON, then relay what matters to the user.

Pass arrays/objects via `--args` as actual JSON (`--args '["a.ts","b.ts"]'`) —
the script receives the parsed value, so `args.filter`/`args.map` work.

## Script format

Plain JavaScript, NOT TypeScript — type annotations, interfaces, and generics
fail to parse. The body runs in an async context — use `await` directly and
`return` your final result. No filesystem or Node.js API access; standard JS
built-ins are available — EXCEPT `Date.now()` / `Math.random()` / argless
`new Date()`, which throw (they would break resume). Pass timestamps in via
`args`; stamp results after the workflow returns; for randomness vary the
agent prompt/label by index.

Every script must begin with `export const meta = {...}` — a PURE LITERAL (no
variables, function calls, spreads, or template interpolation). Required:
`name`, `description`. Optional: `whenToUse`, `phases` (one entry per
`phase()` call; titles are matched exactly).

```js
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',
  phases: [
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix',  detail: 'one agent per flaky test' },
  ],
}
phase('Scan')
const flaky = await agent('grep CI logs for retry markers …', { schema: FLAKY_SCHEMA })
// …
return { flaky }
```

## API

- `agent(prompt, opts?) → Promise<any>` — spawn a subagent. Without `schema`,
  returns its final text as a string. With `schema` (a JSON Schema), the
  subagent is instructed to reply with ONLY matching JSON; the engine
  validates and retries on mismatch, and `agent()` returns the parsed object —
  no parsing needed. Returns `null` if the subagent dies on a terminal error
  after retries (filter with `.filter(Boolean)`). Opts:
  - `label` — display label; `phase` — explicit progress group (use inside
    `pipeline()`/`parallel()` stages to avoid races on the global `phase()`
    state)
  - `model` / `effort` — override for this call. Default to omitting them —
    the agent inherits the session default, which is almost always correct.
    Use low effort for cheap mechanical stages, higher tiers only for the
    hardest verify/judge stages.
  - `isolation: 'worktree'` — fresh detached git worktree, auto-removed if
    unchanged. EXPENSIVE; use ONLY when agents mutate files in parallel and
    would otherwise conflict.
  - `agentType` — run a custom Copilot agent (`copilot --agent <type>`)
    instead of the default; composes with `schema`.
- `pipeline(items, stage1, stage2, …) → Promise<any[]>` — run each item
  through all stages independently, NO barrier between stages. Item A can be
  in stage 3 while item B is still in stage 1. THE DEFAULT for multi-stage
  work: wall-clock = slowest single-item chain, not sum-of-slowest-per-stage.
  Every stage callback receives `(prevResult, originalItem, index)`. A stage
  that throws drops that item to `null` and skips its remaining stages.
- `parallel(thunks) → Promise<any[]>` — run tasks concurrently. This is a
  BARRIER: awaits all thunks before returning. A throwing thunk resolves to
  `null` — the call itself never rejects, so `.filter(Boolean)` before use.
  Use ONLY when you genuinely need all results together.
- `phase(title)` — start a new progress group. `log(message)` — narrator line.
- `args` — the `--args` value, verbatim (`undefined` if not provided).
- `budget` — `{total, spent(), remaining()}`. `total` is `null` without
  `--budget`. The target is a HARD ceiling: once `spent()` reaches `total`,
  further `agent()` calls throw. `remaining()` is `Infinity` with no target.
- `workflow(nameOrRef, args?) → Promise<any>` — run another workflow inline
  and return its return value. Name resolves from `.copilot/workflows/<name>.mjs`
  (project) then `~/.copilot/workflows/<name>.mjs`; or pass `{scriptPath}`.
  The child shares the concurrency cap, agent counter, budget, and journal.
  Nesting is ONE level only. Throws on unknown name / child syntax error.

Subagents are told their final text IS the return value (not a human-facing
message), so they return raw data.

## Caps & concurrency

Concurrent agents: `min(16, cpu cores − 2)` — excess calls queue and run as
slots free up; pass 100 items and all complete. Lifetime cap: 1000 agents per
run (runaway-loop backstop). A single `parallel()`/`pipeline()` call accepts
at most 4096 items — more is an explicit error, not silent truncation.

## pipeline() vs parallel() — DEFAULT TO pipeline()

A barrier is correct ONLY when stage N needs cross-item context from ALL of
stage N−1: dedup/merge across the full result set, early-exit on total count
zero, or a stage prompt that references "the other findings".

A barrier is NOT justified by "I need to flatten/map/filter first" (do it
inside a pipeline stage), "the stages are conceptually separate" (that's what
pipeline models), or "it's cleaner code" (barrier latency is real). Smell
test: `parallel → pure transform → parallel` means the middle transform didn't
need the barrier — rewrite as pipeline. When in doubt: pipeline.

## Canonical patterns

Multi-stage review — each dimension verifies as soon as its review completes:

```js
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA }),
  review => parallel(review.findings.map(f => () =>
    agent(`Adversarially verify: ${f.title}`, { label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA })
      .then(v => ({ ...f, verdict: v }))))
)
const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
return { confirmed }
```

Barrier that IS correct — dedup across all findings before expensive verify:

```js
const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, { schema: FINDINGS_SCHEMA })))
const deduped = dedupeByFileAndLine(all.filter(Boolean).flatMap(r => r.findings))
const verified = await parallel(deduped.map(f => () => agent(verifyPrompt(f), { schema: VERDICT_SCHEMA })))
```

Loop-until-count:

```js
const bugs = []
while (bugs.length < 10) {
  const result = await agent('Find bugs in this codebase.', { schema: BUGS_SCHEMA })
  bugs.push(...result.bugs)
  log(`${bugs.length}/10 found`)
}
```

Loop-until-budget — guard on `budget.total`: with no target, `remaining()` is
`Infinity` and the loop runs straight into the 1000-agent cap:

```js
while (budget.total && budget.remaining() > 50_000) {
  const result = await agent('Find bugs in this codebase.', { schema: BUGS_SCHEMA })
  bugs.push(...result.bugs)
  log(`${bugs.length} found, ${Math.round(budget.remaining() / 1000)}k remaining`)
}
```

Exhaustive review (find → dedup vs seen → diverse-lens panel → loop-until-dry):

```js
const seen = new Set(), confirmed = []
let dry = 0
while (dry < 2) {
  const found = (await parallel(FINDERS.map(f => () =>
    agent(f.prompt, { phase: 'Find', schema: BUGS })))).filter(Boolean).flatMap(r => r.bugs)
  const fresh = found.filter(b => !seen.has(key(b)))     // dedup vs ALL seen — plain code
  if (!fresh.length) { dry++; continue }
  dry = 0; fresh.forEach(b => seen.add(key(b)))
  const judged = await parallel(fresh.map(b => () =>
    parallel(['correctness', 'security', 'repro'].map(lens => () =>
      agent(`Judge "${b.desc}" via the ${lens} lens — real?`, { phase: 'Verify', schema: VERDICT })))
      .then(vs => ({ b, real: vs.filter(Boolean).filter(v => v.real).length >= 2 }))))
  confirmed.push(...judged.filter(v => v.real).map(v => v.b))
}
return confirmed
// dedup vs `seen`, NOT `confirmed` — else judge-rejected findings reappear every round.
```

Quality patterns — pick by task, compose freely:
- **Adversarial verify:** N independent skeptics per finding, each prompted to
  REFUTE; kill if ≥ majority refute.
- **Perspective-diverse verify:** distinct lenses (correctness, security,
  perf, does-it-reproduce) instead of N identical refuters.
- **Judge panel:** N independent attempts from different angles, parallel
  judges score, synthesize from the winner grafting runners-up's best ideas.
- **Loop-until-dry:** for unknown-size discovery, keep spawning finders until
  K consecutive rounds return nothing new.
- **Multi-modal sweep:** parallel agents each searching a different way
  (by-container, by-content, by-entity, by-time).
- **Completeness critic:** a final agent asking "what's missing?" — its
  findings become the next round of work.
- **No silent caps:** if the workflow bounds coverage (top-N, sampling),
  `log()` what was dropped.

Scale to what the user asked for: "find any bugs" → a few finders,
single-vote verify. "thoroughly audit this" → larger pool, 3–5-vote
adversarial pass, synthesis stage.

## Resume

Every run persists `script.mjs`, `meta.json`, `journal.jsonl`, and
`agent-<id>.jsonl` under `~/.copilot/workflows/runs/<runId>/`. After a pause,
kill, or script edit, relaunch with `--resume <runId>` (pointing at the edited
script file): the longest unchanged prefix of `agent()` calls — matched by
call order + (prompt, opts) — returns cached results instantly; the first
edited/new call and everything after it runs live. Same script + same args →
100 % cache hit. Before diagnosing an empty or unexpected result, read the
run's `journal.jsonl` — it records each agent's ACTUAL return value; do not
assume cached results are non-empty.

## Environment knobs

- `WORKFLOW_AGENT_CMD` — replace the backend: the command gets the full prompt
  as its single argument and must print the reply on stdout (used by the test
  suite; also lets you point at another CLI).
- `WORKFLOW_AGENT_ARGS` — extra flags appended to every `copilot` invocation.
  Known copilot `-p` bug: an MCP server that connects AFTER the prompt was sent
  (slow starters like `notebooklm`) makes copilot append an EMPTY user turn —
  the model then echoes system-prompt junk instead of answering. `doctor`
  detects this. Workaround until copilot fixes it:
  `WORKFLOW_AGENT_ARGS="--disable-mcp-server notebooklm"`.
- `WORKFLOW_OUTPUT_FORMAT` — `json` (default; parses Copilot's JSONL, falls
  back to raw stdout) or `text`.
- `WORKFLOW_AGENT_TIMEOUT_MS` — per-agent hard timeout (default 240000). On
  timeout the agent's whole process group is killed, the attempt counts as a
  backend failure, and retries proceed; terminal failure returns `null`.

Subagents spawn detached (own process group, no controlling terminal) — a
misbehaving backend can never take over the user's terminal.

## Claude Code parity mechanisms

- **StructuredOutput as a real tool**: schema agents get a per-agent stdio MCP
  server (`structured-output-mcp.mjs`) injected via `--additional-mcp-config`;
  its `inputSchema` IS the workflow schema and a call writes the arguments to a
  file the engine validates. Text parse remains as fallback (copilot cannot
  force tool_choice). Stub runs skip the MCP and use text parse.
- **Shared token pool**: when the engine runs under a copilot session
  (`$COPILOT_AGENT_SESSION_ID` is set), `budget.spent()` includes the CALLING
  session's output tokens (read incrementally from its `events.jsonl`) — same
  semantics as Claude Code's main-loop + workflows pool. Standalone runs count
  workflow agents only.
- **Schema validator fails loud**: unsupported JSON Schema keywords
  (`$ref`, `patternProperties`, `if/then/else`, tuple `items`, …) throw at
  `agent()` time instead of validating silently. Supported: type, properties,
  required, items, enum, const, anyOf, oneOf (exactly one), allOf, min/max
  (+exclusive), multipleOf, uniqueItems, minLength/maxLength, pattern,
  minItems/maxItems, additionalProperties.
- **Resume cache is occurrence-keyed**: prior results match on
  (prompt+opts, n:th occurrence), so pipeline completion-order races between
  runs cannot break the cache prefix.
- **Worktree**: kept when the agent left uncommitted changes OR new commits
  (HEAD moved); reset to fresh between retry attempts; cleanup runs on every
  exit path.
- **Live view**: `engine.mjs watch <runId>` — the /workflows equivalent
  (phase-grouped tree, refreshes until the run finishes).
- **Background runs**: `engine.mjs run <script> --bg` — detached, logs to
  `<runDir>/out.log`, macOS notification on completion/failure
  (the task-notification equivalent). Follow with `watch`.

Self-test (real Copilot backend, one cheap agent, raw output shown):

```bash
node ~/.copilot/skills/workflows/engine.mjs doctor
node ~/.copilot/skills/workflows/engine.mjs run ~/.copilot/skills/workflows/examples/ping.mjs
```
