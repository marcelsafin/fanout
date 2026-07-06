#!/usr/bin/env node
// engine.mjs — deterministic multi-agent workflow engine for GitHub Copilot CLI.
// 1:1 port of Claude Code's Workflow tool semantics:
//   agent() / parallel() / pipeline() / phase() / log() / args / budget / workflow()
//   - concurrency cap min(16, cpus-2), 1000-agent lifetime cap, 4096-item cap
//   - journal.jsonl per run; resume replays the longest unchanged prefix of agent() calls
//   - schema-forced structured output with validation + retry
//   - Date.now()/Math.random()/argless new Date() throw inside scripts (resume determinism)
// Zero dependencies. Node >= 18.
//
// Usage:
//   node engine.mjs run <script.mjs> [--args '<json>' | --args @file]
//                    [--resume <runId>] [--budget <tokens>] [--model <m>] [--effort <e>]
//                    [--runs-dir <dir>] [--max-concurrency <n>] [-C <cwd>]
//   node engine.mjs list [--runs-dir <dir>]
//   node engine.mjs journal <runId> [--runs-dir <dir>]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, execSync } from 'node:child_process';

// ---------------------------------------------------------------- utilities

const HOME = os.homedir();
const DEFAULT_RUNS_DIR = path.join(HOME, '.copilot', 'workflows', 'runs');
const AGENT_LIFETIME_CAP = 1000;
const ITEM_CAP = 4096;
const SPAWN_RETRIES = 2;   // retries on backend failure
const SCHEMA_RETRIES = 2;  // extra retries when output fails schema validation

function die(msg) { process.stderr.write(`workflow: ${msg}\n`); process.exit(1); }
function newRunId() {
  return 'wf_' + Array.from({ length: 12 }, () =>
    'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
}
function shortLabel(prompt) {
  const s = prompt.replace(/\s+/g, ' ').trim();
  return s.length <= 48 ? s : s.slice(0, 45) + '…';
}
// Stable stringify (sorted keys) so cache keys don't depend on property order.
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function estimateTokens(text) { return Math.ceil((text || '').length / 4); }

class Semaphore {
  constructor(n) { this.free = n; this.queue = []; }
  async acquire() {
    if (this.free > 0) { this.free--; return; }
    await new Promise(r => this.queue.push(r));
  }
  release() {
    const next = this.queue.shift();
    if (next) next(); else this.free++;
  }
}

// ------------------------------------------------- minimal JSON Schema check
// Subset validator: type, enum, const, properties/required/additionalProperties,
// items, min/max, minLength/maxLength, minItems/maxItems, pattern, anyOf/oneOf/allOf.
// Returns first error string, or null when valid.
function validateSchema(value, schema, loc = '$') {
  if (schema == null || typeof schema !== 'object') return null;
  const typeOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  if (schema.const !== undefined && stableStringify(value) !== stableStringify(schema.const))
    return `${loc}: expected const ${JSON.stringify(schema.const)}`;
  if (schema.enum && !schema.enum.some(e => stableStringify(e) === stableStringify(value)))
    return `${loc}: value not in enum ${JSON.stringify(schema.enum)}`;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    const ok = types.some(x => x === t || (x === 'integer' && t === 'number' && Number.isInteger(value)));
    if (!ok) return `${loc}: expected type ${types.join('|')}, got ${t}`;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${loc}: ${value} < minimum ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${loc}: ${value} > maximum ${schema.maximum}`;
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return `${loc}: ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`;
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return `${loc}: ${value} >= exclusiveMaximum ${schema.exclusiveMaximum}`;
    if (schema.multipleOf !== undefined && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9)
      return `${loc}: ${value} is not a multiple of ${schema.multipleOf}`;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${loc}: string shorter than minLength ${schema.minLength}`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${loc}: string longer than maxLength ${schema.maxLength}`;
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) return `${loc}: string does not match pattern ${schema.pattern}`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${loc}: fewer than minItems ${schema.minItems}`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${loc}: more than maxItems ${schema.maxItems}`;
    if (schema.uniqueItems && new Set(value.map(v => stableStringify(v))).size !== value.length)
      return `${loc}: items are not unique`;
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const err = validateSchema(value[i], schema.items, `${loc}[${i}]`);
        if (err) return err;
      }
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const req of schema.required || []) {
      if (!(req in value)) return `${loc}: missing required property "${req}"`;
    }
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in value) {
          const err = validateSchema(value[k], sub, `${loc}.${k}`);
          if (err) return err;
        }
      }
      if (schema.additionalProperties === false) {
        for (const k of Object.keys(value)) {
          if (!(k in schema.properties)) return `${loc}: unexpected property "${k}"`;
        }
      }
    }
  }
  if (schema.allOf) {
    for (const sub of schema.allOf) {
      const err = validateSchema(value, sub, loc);
      if (err) return err;
    }
  }
  if (schema.anyOf) {
    const errs = schema.anyOf.map(sub => validateSchema(value, sub, loc));
    if (!errs.some(e => e === null)) return `${loc}: no anyOf branch matched (${errs[0]})`;
  }
  if (schema.oneOf) {
    const hits = schema.oneOf.filter(sub => validateSchema(value, sub, loc) === null).length;
    if (hits !== 1) return `${loc}: oneOf matched ${hits} branches, expected exactly 1`;
  }
  return null;
}

// Fail LOUD on schema keywords the subset validator would silently ignore —
// a schema author must never be lulled into thinking an unsupported constraint holds.
const SUPPORTED_KEYWORDS = new Set(['type', 'properties', 'required', 'items', 'enum', 'const',
  'anyOf', 'oneOf', 'allOf', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'multipleOf', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems',
  'additionalProperties', 'description', 'title', 'default', 'examples', '$schema', '$id']);
function assertSchemaSupported(schema, loc = '$') {
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema)) return;
  for (const k of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(k))
      throw new Error(`schema at ${loc} uses unsupported keyword "${k}" — the built-in validator cannot enforce it`);
  }
  if (schema.properties) for (const [k, sub] of Object.entries(schema.properties)) assertSchemaSupported(sub, `${loc}.${k}`);
  if (schema.items && !Array.isArray(schema.items)) assertSchemaSupported(schema.items, `${loc}[]`);
  if (Array.isArray(schema.items)) throw new Error(`schema at ${loc}: tuple-form "items" arrays are not supported`);
  for (const combo of ['anyOf', 'oneOf', 'allOf'])
    if (schema[combo]) schema[combo].forEach((sub, i) => assertSchemaSupported(sub, `${loc}<${combo}[${i}]>`));
  if (typeof schema.additionalProperties === 'object') assertSchemaSupported(schema.additionalProperties, `${loc}.*`);
}

// Extract the first balanced JSON object/array from model text (fences tolerated).
function extractJson(text) {
  let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = s.search(/[{[]/);
  if (start === -1) return { ok: false, error: 'no JSON object/array found in output' };
  const open = s[start], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try { return { ok: true, value: JSON.parse(s.slice(start, i + 1)) }; }
        catch (e) { return { ok: false, error: `JSON parse error: ${e.message}` }; }
      }
    }
  }
  return { ok: false, error: 'unbalanced JSON in output' };
}

// ------------------------------------------------------------ meta parsing

// Script must begin with `export const meta = {...}` — a PURE literal.
function parseMeta(source, file) {
  const m = source.match(/export\s+const\s+meta\s*=\s*/);
  if (!m || source.slice(0, m.index).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|\s/g, '') !== '')
    throw new Error(`${file}: script must begin with \`export const meta = {...}\``);
  const start = m.index + m[0].length;
  if (source[start] !== '{') throw new Error(`${file}: meta must be an object literal`);
  // find balanced closing brace
  let depth = 0, inStr = false, strCh = '', esc = false, end = -1;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === '\\') esc = true; else if (c === strCh) inStr = false; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; }
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error(`${file}: unterminated meta object`);
  const literal = source.slice(start, end + 1);
  let meta;
  try {
    // Empty context: any identifier/function reference throws → enforces pure literal.
    meta = vm.runInNewContext('(' + literal + ')', vm.createContext(Object.create(null)), { timeout: 1000 });
  } catch (e) {
    throw new Error(`${file}: meta must be a pure literal (no variables, calls, spreads): ${e.message}`);
  }
  if (!meta || typeof meta.name !== 'string' || typeof meta.description !== 'string')
    throw new Error(`${file}: meta requires string fields "name" and "description"`);
  if (meta.phases !== undefined && (!Array.isArray(meta.phases) ||
      meta.phases.some(p => !p || typeof p.title !== 'string')))
    throw new Error(`${file}: meta.phases must be an array of { title, detail? } objects`);
  return { meta, bodyStart: 0, literalEnd: end + 1 };
}

// ------------------------------------------------------------ agent backend

function backendCommand(promptText, opts, runState) {
  if (process.env.WORKFLOW_AGENT_CMD) {
    // WORKFLOW_STUB_FORMAT=json lets tests replay captured copilot JSONL through the real parser
    return { cmd: process.env.WORKFLOW_AGENT_CMD, argv: [promptText], raw: process.env.WORKFLOW_STUB_FORMAT !== 'json' };
  }
  const outFmt = process.env.WORKFLOW_OUTPUT_FORMAT || 'json';
  const argv = ['-p', promptText, '--allow-all-tools', '--no-ask-user', '--no-color', '--log-level', 'none'];
  if (outFmt === 'json') argv.push('--output-format', 'json');
  const model = opts.model || runState.defaultModel;
  const effort = opts.effort || runState.defaultEffort;
  if (model) argv.push('--model', model);
  if (effort) argv.push('--effort', effort);
  if (opts.agentType) argv.push('--agent', opts.agentType);
  if (opts._mcp) argv.push('--additional-mcp-config', JSON.stringify({ mcpServers: { 'workflow-output': {
    type: 'stdio', command: process.execPath, args: [MCP_SERVER],
    env: { WF_OUT: opts._mcp.out, WF_SCHEMA: opts._mcp.schema }, tools: ['*'],
  } } }));
  if (process.env.WORKFLOW_AGENT_ARGS) argv.push(...process.env.WORKFLOW_AGENT_ARGS.split(/\s+/).filter(Boolean));
  return { cmd: 'copilot', argv, raw: outFmt !== 'json' };
}

// Defensive JSONL parser: find assistant text + token usage across plausible
// event shapes; fall back to raw stdout when nothing parses.
function parseBackendOutput(stdout, raw) {
  if (raw) return { text: stdout.trim(), tokens: null };
  let text = null, tokens = null;
  const pickText = obj => {
    if (typeof obj === 'string') return obj;
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.content === 'string') return obj.content;
    if (Array.isArray(obj.content))
      return obj.content.map(c => (typeof c === 'string' ? c : c?.text || '')).join('');
    return null;
  };
  let sawJson = false, sumOut = 0;
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    sawJson = true;
    const role = ev.role || ev.message?.role || (typeof ev.type === 'string' && ev.type.includes('assistant') ? 'assistant' : null);
    const candidate = pickText(ev) ?? pickText(ev.message) ?? pickText(ev.data) ?? pickText(ev.delta);
    if (candidate && (role === 'assistant' || role === null)) {
      if (ev.type && /tool|user|system|thinking|reasoning/i.test(ev.type)) continue;
      text = candidate; // keep last plausible assistant text
    }
    const usage = ev.usage || ev.message?.usage || ev.data?.usage || ev.stats;
    if (usage) {
      const out = usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? null;
      const inn = usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? 0;
      const tot = usage.total_tokens ?? usage.totalTokens ?? null;
      tokens = out != null ? out : (tot != null ? Math.max(0, tot - inn) : tokens);
    } else if (typeof ev.data?.outputTokens === 'number') {
      // copilot JSONL: per-API-call outputTokens sits directly on assistant.message data — sum across turns
      sumOut += ev.data.outputTokens;
    }
  }
  if (tokens == null && sumOut > 0) tokens = sumOut; // explicit usage object wins over the sum
  if (text == null) text = sawJson ? '' : stdout.trim(); // fallback: raw stdout
  return { text, tokens };
}

const AGENT_TIMEOUT_MS = parseInt(process.env.WORKFLOW_AGENT_TIMEOUT_MS || '240000', 10);

function runBackendOnce(promptText, opts, runState, cwd) {
  const { cmd, argv, raw } = backendCommand(promptText, opts, runState);
  return new Promise(resolve => {
    // detached: own process group + no controlling terminal — the child can never
    // grab the user's tty (interactive-TUI fallback) and a timeout kills the whole group.
    const child = spawn(cmd, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(opts._env || {}) }, detached: true });
    let out = '', err = '', done = false;
    const finish = res => { if (!done) { done = true; clearTimeout(timer); resolve(res); } };
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      finish({ ok: false, error: `agent timeout after ${AGENT_TIMEOUT_MS}ms`, stdout: out, stderr: err });
    }, AGENT_TIMEOUT_MS);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => finish({ ok: false, error: e.message, stdout: out, stderr: err }));
    child.on('close', code => {
      if (code !== 0) return finish({ ok: false, error: `exit ${code}: ${err.slice(0, 400)}`, stdout: out, stderr: err });
      const { text, tokens } = parseBackendOutput(out, raw);
      finish({ ok: true, text, tokens: tokens ?? estimateTokens(text), usageReal: tokens != null, stdout: out });
    });
  });
}

const SUBAGENT_PREAMBLE =
  'You are a workflow subagent inside a deterministic orchestration script. ' +
  'Your final message text IS the return value consumed programmatically by the script — ' +
  'it is not shown to a human. Return raw data only: no preamble, no closing remarks.\n\n';

const MCP_SERVER = path.join(path.dirname(new URL(import.meta.url).pathname), 'structured-output-mcp.mjs');

function schemaInstruction(schema, viaTool) {
  // viaTool = Claude Code parity: schema enforced at the tool-call layer.
  if (viaTool) return '\n\nOUTPUT (mandatory): submit your final answer by calling the StructuredOutput tool ' +
    '(from the workflow-output MCP server) EXACTLY ONCE, with arguments that validate against its input schema. ' +
    'Do NOT print the JSON as plain text. Schema for reference:\n' + JSON.stringify(schema, null, 2);
  return '\n\nOUTPUT FORMAT (mandatory): reply with ONLY a single JSON value — no markdown fences, ' +
    'no prose before or after — that validates against this JSON Schema:\n' + JSON.stringify(schema, null, 2);
}

// ---------------------------------------------------------------- run state

function createRunState(cfg) {
  return {
    runId: cfg.runId,
    runDir: cfg.runDir,
    cwd: cfg.cwd,
    defaultModel: cfg.model || null,
    defaultEffort: cfg.effort || null,
    sem: new Semaphore(cfg.maxConcurrency),
    maxConcurrency: cfg.maxConcurrency,
    agentCount: 0,       // lifetime count (cap 1000), shared with child workflows
    callSeq: 0,          // deterministic agent() call ids, shared with children
    spentTokens: 0,
    budgetTotal: cfg.budgetTotal,   // null = no target
    // Resume cache keyed by (key, occurrence) — global call ids race under
    // pipeline concurrency; the n:th identical (prompt, opts) is stable.
    prevByKey: (() => {
      const m = new Map();
      [...cfg.prevJournal.values()].sort((a, b) => a.id - b.id)
        .forEach(e => { if (!m.has(e.key)) m.set(e.key, []); m.get(e.key).push(e); });
      return m;
    })(),
    keySeen: new Map(),
    prefixBroken: cfg.prevJournal.size === 0, // no prior journal → nothing to replay
    journalPath: path.join(cfg.runDir, 'journal.jsonl'),
    liveAgents: 0,
    cachedHits: 0,
    // Shared token pool with the calling copilot session (Claude Code parity):
    // copilot exports COPILOT_AGENT_SESSION_ID to child processes.
    mainEvents: process.env.COPILOT_AGENT_SESSION_ID
      ? path.join(os.homedir(), '.copilot', 'session-state', process.env.COPILOT_AGENT_SESSION_ID, 'events.jsonl')
      : null,
    mainOffset: 0,
    mainSum: 0,
  };
}

// Output tokens spent by the CALLING copilot session (the "main loop"), read
// incrementally from its events.jsonl. 0 when not running under a copilot session.
function mainLoopTokens(state) {
  if (!state.mainEvents) return 0;
  try {
    const size = fs.statSync(state.mainEvents).size;
    if (size > state.mainOffset) {
      const fd = fs.openSync(state.mainEvents, 'r');
      const buf = Buffer.alloc(size - state.mainOffset);
      fs.readSync(fd, buf, 0, buf.length, state.mainOffset);
      fs.closeSync(fd);
      const chunk = buf.toString('utf8');
      const lastNl = chunk.lastIndexOf('\n');
      if (lastNl >= 0) {
        for (const line of chunk.slice(0, lastNl).split('\n')) {
          if (!line.includes('outputTokens')) continue;
          try {
            const ev = JSON.parse(line);
            if (typeof ev.data?.outputTokens === 'number') state.mainSum += ev.data.outputTokens;
          } catch {}
        }
        state.mainOffset += lastNl + 1;
      }
    }
  } catch {}
  return state.mainSum;
}
function totalSpent(state) { return state.spentTokens + mainLoopTokens(state); }

function journalAppend(state, entry) {
  fs.appendFileSync(state.journalPath, JSON.stringify(entry) + '\n');
  state.metaWriter?.('running'); // keep meta.json live for `watch`
}

// ------------------------------------------------------------- workflow API

function makeApi(state, depth, phaseBox) {
  const progress = (line) => process.stderr.write(line + '\n');

  async function agent(prompt, opts = {}) {
    if (typeof prompt !== 'string' || !prompt.trim())
      throw new Error('agent() requires a non-empty prompt string');
    state.agentCount++;
    if (state.agentCount > AGENT_LIFETIME_CAP)
      throw new Error(`agent cap exceeded: ${AGENT_LIFETIME_CAP} agents per workflow run`);
    const id = state.callSeq++;
    const phaseName = opts.phase ?? phaseBox.current;
    const label = opts.label || shortLabel(prompt);
    const key = stableStringify({ prompt, opts });
    if (opts.schema) assertSchemaSupported(opts.schema); // loud, before any spawn

    // Resume: serve prior results by (key, occurrence) — stable under pipeline races.
    const occ = state.keySeen.get(key) ?? 0;
    state.keySeen.set(key, occ + 1);
    if (!state.prefixBroken) {
      const prev = state.prevByKey.get(key)?.[occ];
      if (prev) {
        state.cachedHits++;
        journalAppend(state, { ...prev, id, cached: true });
        progress(`  ↺ #${id} ${label} (cached)`);
        return prev.result;
      }
      state.prefixBroken = true; // first edited/new call → everything after runs live
    }

    // Budget is a HARD ceiling for live agents (shared with the calling session).
    if (state.budgetTotal != null && totalSpent(state) >= state.budgetTotal)
      throw new Error(`token budget exhausted (${totalSpent(state)}/${state.budgetTotal}) — agent() refused`);

    const tQueued = Date.now();
    await state.sem.acquire();
    const t0 = Date.now();
    let worktree = null, baseSha = null;
    try {
      // Re-check after the queue wait: agents that ran meanwhile may have exhausted the budget.
      if (state.budgetTotal != null && totalSpent(state) >= state.budgetTotal)
        throw new Error(`token budget exhausted (${totalSpent(state)}/${state.budgetTotal}) — agent() refused`);
      let cwd = state.cwd;
      if (opts.isolation === 'worktree') {
        worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-worktree-'));
        execSync(`git worktree add --detach "${worktree}"`, { cwd: state.cwd, stdio: 'pipe' });
        baseSha = execSync('git rev-parse HEAD', { cwd: worktree, stdio: 'pipe' }).toString().trim();
        cwd = worktree;
      }

      state.liveAgents++;
      progress(`  ▶ #${id} ${label}${phaseName ? ` [${phaseName}]` : ''}`);

      // Schema agents get a real StructuredOutput TOOL (Claude Code parity): a per-agent
      // stdio MCP server whose inputSchema IS the workflow schema; a call lands in outPath.
      // Text parse remains as fallback (copilot cannot force tool_choice).
      let outPath = null, mcp = null;
      if (opts.schema) {
        outPath = path.join(state.runDir, `structured-${id}.json`);
        if (!process.env.WORKFLOW_AGENT_CMD) {
          const schemaPath = path.join(state.runDir, `schema-${id}.json`);
          fs.writeFileSync(schemaPath, JSON.stringify(opts.schema));
          mcp = { schema: schemaPath, out: outPath };
        }
      }
      const optsRun = { ...opts, _mcp: mcp, _env: outPath ? { WORKFLOW_STRUCTURED_OUT: outPath } : null };

      let fullPrompt = SUBAGENT_PREAMBLE + prompt + (opts.schema ? schemaInstruction(opts.schema, !!mcp) : '');
      let result = null, tokens = 0, lastError = null, usageReal = false, attemptsUsed = 0;
      const maxAttempts = 1 + SPAWN_RETRIES + (opts.schema ? SCHEMA_RETRIES : 0);
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        attemptsUsed = attempt + 1;
        if (attempt > 0) {
          // Budget is re-checked between attempts, and a reused worktree is reset to fresh.
          if (state.budgetTotal != null && totalSpent(state) >= state.budgetTotal) {
            lastError = `token budget exhausted (${totalSpent(state)}/${state.budgetTotal}) during retries`;
            break;
          }
          if (worktree) try { execSync('git checkout -- . && git clean -fdq', { cwd: worktree, stdio: 'pipe' }); } catch {}
        }
        const res = await runBackendOnce(fullPrompt, optsRun, state, cwd);
        if (!res.ok) { lastError = res.error; continue; } // backend failure → retry
        tokens += res.tokens;
        state.spentTokens += res.tokens; // book per attempt so concurrent agents see live spend
        usageReal = usageReal || !!res.usageReal;
        if (!opts.schema) { result = res.text.trim(); lastError = null; break; }
        let parsed;
        if (outPath && fs.existsSync(outPath)) {
          try { parsed = { ok: true, value: JSON.parse(fs.readFileSync(outPath, 'utf8')) }; }
          catch (e) { parsed = { ok: false, error: 'StructuredOutput arguments unreadable: ' + e.message }; }
          try { fs.unlinkSync(outPath); } catch {}
        } else {
          parsed = extractJson(res.text);
        }
        const err = parsed.ok ? validateSchema(parsed.value, opts.schema) : parsed.error;
        if (!err) { result = parsed.value; lastError = null; break; }
        lastError = err;
        const prevOut = (parsed.ok ? JSON.stringify(parsed.value) : res.text || '').slice(0, 4000);
        fullPrompt += `\n\nYour previous output was invalid: ${err}\nYour previous output was:\n${prevOut}\nReply again with ONLY the corrected JSON.`;
      }

      if (lastError !== null) {
        // Terminal failure after retries → null (never throws), matching Workflow semantics.
        progress(`  ✖ #${id} ${label} → null (${String(lastError).slice(0, 120)})`);
        journalAppend(state, { id, key, label, phase: phaseName, result: null, tokens, error: String(lastError),
          startedAt: new Date(t0).toISOString(), queuedMs: t0 - tQueued, ms: Date.now() - t0, attempts: attemptsUsed });
        try { fs.writeFileSync(path.join(state.runDir, `agent-${id}.jsonl`), JSON.stringify({ id, prompt, opts, error: lastError }) + '\n'); } catch {}
        return null;
      }
      progress(`  ✔ #${id} ${label} (${usageReal ? '' : '~'}${(tokens / 1000).toFixed(1)}k tok)`);
      journalAppend(state, { id, key, label, phase: phaseName, result, tokens, usage: usageReal ? 'copilot' : 'estimate',
        startedAt: new Date(t0).toISOString(), queuedMs: t0 - tQueued, ms: Date.now() - t0, attempts: attemptsUsed });
      try { fs.writeFileSync(path.join(state.runDir, `agent-${id}.jsonl`), JSON.stringify({ id, prompt, opts, result, tokens }) + '\n'); } catch {}
      return result;
    } finally {
      // Worktree cleanup runs on EVERY exit path (success, null, throw). Kept only
      // when the agent left uncommitted changes OR moved HEAD (committed work).
      if (worktree) {
        try {
          const dirty = execSync('git status --porcelain', { cwd: worktree, stdio: 'pipe' }).toString().trim();
          const head = execSync('git rev-parse HEAD', { cwd: worktree, stdio: 'pipe' }).toString().trim();
          if (!dirty && head === baseSha) {
            execSync(`git worktree remove --force "${worktree}"`, { cwd: state.cwd, stdio: 'pipe' });
          } else {
            progress(`  ⚠ #${id} worktree kept (${dirty ? 'uncommitted changes' : 'new commits at ' + head.slice(0, 8)}): ${worktree}`);
          }
        } catch {}
      }
      state.sem.release();
    }
  }

  async function parallel(thunks) {
    if (!Array.isArray(thunks)) throw new TypeError('parallel() expects an array of thunks');
    if (thunks.length > ITEM_CAP) throw new Error(`parallel(): ${thunks.length} items exceeds the ${ITEM_CAP}-item cap`);
    // Barrier: awaits all; a throwing thunk resolves to null — the call never rejects.
    return Promise.all(thunks.map(t =>
      Promise.resolve().then(t).catch(e => { progress(`  ⚠ parallel thunk → null: ${e.message}`); return null; })));
  }

  async function pipeline(items, ...stages) {
    if (!Array.isArray(items)) throw new TypeError('pipeline() expects an items array');
    if (items.length > ITEM_CAP) throw new Error(`pipeline(): ${items.length} items exceeds the ${ITEM_CAP}-item cap`);
    // No barrier between stages: each item flows through all stages independently.
    return Promise.all(items.map((item, index) => (async () => {
      let cur = item;
      for (const stage of stages) cur = await stage(cur, item, index);
      return cur;
    })().catch(e => { progress(`  ⚠ pipeline item #${index} → null: ${e.message}`); return null; })));
  }

  function phase(title) {
    phaseBox.current = title;
    progress(`\n── Phase: ${title} ──`);
  }

  function log(message) { progress(`• ${message}`); }

  const budget = {
    get total() { return state.budgetTotal; },
    spent: () => totalSpent(state),
    remaining: () => state.budgetTotal == null ? Infinity : Math.max(0, state.budgetTotal - totalSpent(state)),
  };

  async function workflowFn(nameOrRef, childArgs) {
    if (depth >= 1) throw new Error('workflow() nesting is limited to one level');
    let scriptPath;
    if (nameOrRef && typeof nameOrRef === 'object' && nameOrRef.scriptPath) {
      scriptPath = path.resolve(state.cwd, nameOrRef.scriptPath);
      if (!fs.existsSync(scriptPath)) throw new Error(`workflow(): script not found: ${scriptPath}`);
    } else if (typeof nameOrRef === 'string') {
      const candidates = [
        path.join(state.cwd, '.copilot', 'workflows', nameOrRef + '.mjs'),
        path.join(HOME, '.copilot', 'workflows', nameOrRef + '.mjs'),
      ];
      scriptPath = candidates.find(p => fs.existsSync(p));
      if (!scriptPath) throw new Error(`workflow(): unknown workflow "${nameOrRef}" (looked in ${candidates.join(', ')})`);
    } else {
      throw new Error('workflow() expects a name string or {scriptPath}');
    }
    progress(`\n▸ sub-workflow: ${path.basename(scriptPath)}`);
    // Child shares state (concurrency cap, agent counter, budget, journal).
    return executeScript(scriptPath, childArgs, state, depth + 1);
  }

  return { agent, parallel, pipeline, phase, log, budget, workflow: workflowFn };
}

// ------------------------------------------------------------ script runner

// Prelude run inside the sandbox realm: determinism guards (1:1 with Workflow).
const SANDBOX_PRELUDE = `
(() => {
  const fail = what => { throw new Error(what + ' is unavailable in workflow scripts (it would break resume) — pass timestamps in via args, stamp results after the workflow returns, and vary prompts by index instead of randomness'); };
  const RealDate = Date;
  globalThis.Date = new Proxy(RealDate, {
    apply() { fail('Date()'); },
    construct(target, a) { if (a.length === 0) fail('new Date()'); return Reflect.construct(target, a); },
    get(t, p, r) { if (p === 'now') return () => fail('Date.now()'); return Reflect.get(t, p, r); }
  });
  Math.random = () => fail('Math.random()');
})();`;

async function executeScript(scriptFile, argsValue, state, depth) {
  const source = fs.readFileSync(scriptFile, 'utf8');
  const { meta } = parseMeta(source, path.basename(scriptFile));
  const body = source.replace(/export\s+const\s+meta\s*=/, 'const meta =');

  const sandbox = { console: { log: m => process.stderr.write(`• ${m}\n`), error: m => process.stderr.write(`! ${m}\n`) } };
  const context = vm.createContext(sandbox);
  vm.runInContext(SANDBOX_PRELUDE, context, { filename: 'prelude' });

  const phaseBox = { current: null };
  const api = makeApi(state, depth, phaseBox);

  let fn;
  try {
    fn = vm.runInContext(
      '(async (agent, parallel, pipeline, phase, log, workflow, args, budget) => {\n"use strict";\n' + body + '\n})',
      context, { filename: path.basename(scriptFile) });
  } catch (e) {
    throw new Error(`syntax error in ${path.basename(scriptFile)}: ${e.message}`);
  }
  if (depth === 0) process.stderr.write(`workflow ${meta.name} — ${meta.description}\n  run ${state.runId}, concurrency ${state.maxConcurrency}, budget ${state.budgetTotal ?? 'none'}\n`);
  return fn(api.agent, api.parallel, api.pipeline, api.phase, api.log, api.workflow, argsValue, api.budget);
}

// ------------------------------------------------------------------ CLI

function parseCliArgs(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-C') flags.cwd = argv[++i];
    else if (a.startsWith('--')) {
      const name = a.slice(2);
      if (['args', 'resume', 'budget', 'model', 'effort', 'runs-dir', 'max-concurrency', 'run-id'].includes(name)) flags[name] = argv[++i];
      else flags[name] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

function loadPrevJournal(runsDir, resumeId) {
  const map = new Map();
  if (!resumeId) return map;
  const p = path.join(runsDir, resumeId, 'journal.jsonl');
  if (!fs.existsSync(p)) die(`resume: no journal for run ${resumeId} at ${p}`);
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); map.set(e.id, e); } catch {}
  }
  return map;
}

async function cmdRun({ flags, pos }) {
  const scriptFile = pos[0];
  if (!scriptFile) die('usage: engine.mjs run <script.mjs> [--args <json>] [--resume <runId>] [--budget <n>]');
  const abs = path.resolve(scriptFile);
  if (!fs.existsSync(abs)) die(`script not found: ${abs}`);

  let argsValue;
  if (flags.args != null) {
    const rawArgs = flags.args.startsWith('@') ? fs.readFileSync(flags.args.slice(1), 'utf8') : flags.args;
    try { argsValue = JSON.parse(rawArgs); } catch { argsValue = rawArgs; } // non-JSON → pass as string
  }

  const runsDir = flags['runs-dir'] ? path.resolve(flags['runs-dir']) : DEFAULT_RUNS_DIR;
  const runId = flags['run-id'] || newRunId();
  const runDir = path.join(runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.copyFileSync(abs, path.join(runDir, 'script.mjs'));

  if (flags.bg) {
    // Background run: re-spawn ourselves detached (same pattern as subagent spawn),
    // logs to runDir/out.log, completion notification handled by the child (WORKFLOW_BG=1).
    const argv = process.argv.slice(2).filter(a => a !== '--bg');
    argv.push('--run-id', runId);
    const logFd = fs.openSync(path.join(runDir, 'out.log'), 'a');
    const child = spawn(process.execPath, [process.argv[1], ...argv],
      { detached: true, stdio: ['ignore', logFd, logFd], env: { ...process.env, WORKFLOW_BG: '1' } });
    child.unref();
    process.stdout.write(JSON.stringify({ runId, ok: true, background: true, pid: child.pid,
      watch: `engine.mjs watch ${runId}`, log: path.join(runDir, 'out.log') }, null, 2) + '\n');
    return;
  }

  if (flags.budget != null && !Number.isFinite(parseInt(flags.budget, 10)))
    die(`--budget must be a number, got: ${flags.budget}`);
  if (flags['max-concurrency'] != null && !Number.isFinite(parseInt(flags['max-concurrency'], 10)))
    die(`--max-concurrency must be a number, got: ${flags['max-concurrency']}`);
  const maxConcurrency = flags['max-concurrency']
    ? Math.min(16, Math.max(1, parseInt(flags['max-concurrency'], 10))) // spec ceiling: 16
    : Math.min(16, Math.max(1, os.cpus().length - 2));

  const state = createRunState({
    runId, runDir,
    cwd: flags.cwd ? path.resolve(flags.cwd) : process.cwd(),
    model: flags.model, effort: flags.effort,
    maxConcurrency,
    budgetTotal: flags.budget != null ? parseInt(flags.budget, 10) : null,
    prevJournal: loadPrevJournal(runsDir, flags.resume),
  });

  const metaPath = path.join(runDir, 'meta.json');
  const startedAt = new Date().toISOString();
  const writeMeta = status => fs.writeFileSync(metaPath, JSON.stringify({
    runId, script: abs, status, args: argsValue ?? null, resumedFrom: flags.resume ?? null,
    startedAt, agents: state.callSeq, cached: state.cachedHits, tokens: state.spentTokens,
  }, null, 2));
  writeMeta('running');
  state.metaWriter = writeMeta;
  process.on('SIGINT', () => { writeMeta('aborted'); process.stderr.write('\naborted — journal saved; resume with --resume ' + runId + '\n'); process.exit(130); });

  const notify = status => { // task-notification equivalent for --bg runs (macOS)
    if (process.env.WORKFLOW_BG !== '1' || process.platform !== 'darwin') return;
    try {
      execSync(`osascript -e 'display notification "run ${runId}: ${status}" with title "workflow ${path.basename(abs)}"'`, { stdio: 'ignore' });
    } catch {}
  };
  try {
    const result = await executeScript(abs, argsValue, state, 0);
    writeMeta('completed');
    notify('completed');
    process.stderr.write(`\ndone — ${state.liveAgents} live agents, ${state.cachedHits} cached, ~${(state.spentTokens / 1000).toFixed(1)}k tokens\n`);
    process.stdout.write(JSON.stringify({ runId, ok: true, result: result ?? null, agents: { live: state.liveAgents, cached: state.cachedHits }, tokens: state.spentTokens }, null, 2) + '\n');
  } catch (e) {
    writeMeta('failed');
    notify('FAILED');
    process.stdout.write(JSON.stringify({ runId, ok: false, error: e.message, agents: { live: state.liveAgents, cached: state.cachedHits }, tokens: state.spentTokens }, null, 2) + '\n');
    process.exitCode = 1;
  }
}

// Live progress view — the /workflows equivalent. Re-renders the phase-grouped
// tree from journal.jsonl + meta.json until the run leaves 'running'.
async function cmdWatch({ flags, pos }) {
  const runsDir = flags['runs-dir'] ? path.resolve(flags['runs-dir']) : DEFAULT_RUNS_DIR;
  const runDir = path.join(runsDir, pos[0] || '');
  if (!pos[0] || !fs.existsSync(runDir)) die('usage: engine.mjs watch <runId>');
  const readMeta = () => { try { return JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8')); } catch { return null; } };
  const readJournal = () => {
    try {
      return fs.readFileSync(path.join(runDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  };
  const render = (meta, entries) => {
    const lines = [`workflow ${path.basename(meta?.script || '?')} — ${meta?.status ?? '?'}   ` +
      `(${entries.length}/${meta?.agents ?? '?'} klara, ${meta?.cached ?? 0} cached, ~${((meta?.tokens ?? 0) / 1000).toFixed(1)}k tok)`];
    const byPhase = new Map();
    for (const e of entries) {
      const key = e.phase || '(no phase)';
      if (!byPhase.has(key)) byPhase.set(key, []);
      byPhase.get(key).push(e);
    }
    for (const [ph, es] of byPhase) {
      lines.push(`── ${ph} ──`);
      for (const e of es) {
        const mark = e.error != null ? '✖' : '✔';
        const extra = e.cached ? 'cached' : `${e.tokens ?? 0} tok, ${((e.ms ?? 0) / 1000).toFixed(1)}s` + (e.queuedMs > 500 ? `, kö ${(e.queuedMs / 1000).toFixed(1)}s` : '');
        lines.push(`  ${mark} #${e.id} ${e.label} (${extra})${e.error ? ' — ' + String(e.error).slice(0, 80) : ''}`);
      }
    }
    process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n') + '\n');
  };
  for (;;) {
    const meta = readMeta();
    render(meta, readJournal());
    if (meta && meta.status !== 'running') break;
    await new Promise(r => setTimeout(r, 500));
  }
}

function cmdList({ flags }) {
  const runsDir = flags['runs-dir'] ? path.resolve(flags['runs-dir']) : DEFAULT_RUNS_DIR;
  if (!fs.existsSync(runsDir)) return console.log('(no runs)');
  const rows = fs.readdirSync(runsDir).filter(d => d.startsWith('wf_')).map(d => {
    try { return JSON.parse(fs.readFileSync(path.join(runsDir, d, 'meta.json'), 'utf8')); }
    catch { return { runId: d, status: '?' }; }
  }).sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''));
  for (const r of rows)
    console.log(`${r.runId}  ${String(r.status).padEnd(9)}  ${r.startedAt ?? ''}  ${path.basename(r.script || '')}`);
}

function cmdJournal({ flags, pos }) {
  const runsDir = flags['runs-dir'] ? path.resolve(flags['runs-dir']) : DEFAULT_RUNS_DIR;
  const p = path.join(runsDir, pos[0] || '', 'journal.jsonl');
  if (!pos[0] || !fs.existsSync(p)) die('usage: engine.mjs journal <runId> — journal not found');
  process.stdout.write(fs.readFileSync(p, 'utf8'));
}

// Backend self-diagnosis: one cheap agent, raw output shown — verifies binary
// resolution, non-interactive exit, JSONL parsing, and real-vs-estimated tokens.
async function cmdDoctor() {
  let resolved = '(not found)';
  try { resolved = execSync('command -v copilot 2>/dev/null || true', { shell: '/bin/zsh' }).toString().trim() || resolved; } catch {}
  process.stderr.write(`backend: ${process.env.WORKFLOW_AGENT_CMD || 'copilot'} (PATH resolves: ${resolved})\n` +
    `timeout: ${AGENT_TIMEOUT_MS}ms, output format: ${process.env.WORKFLOW_OUTPUT_FORMAT || 'json'}\n`);
  const t0 = Date.now();
  const res = await runBackendOnce(SUBAGENT_PREAMBLE + 'Reply with exactly the single word: PONG', {}, { defaultModel: null, defaultEffort: null }, process.cwd());
  process.stderr.write(`elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  if (!res.ok) {
    process.stderr.write(`FAIL: ${res.error}\n--- stderr head ---\n${(res.stderr || '').slice(0, 600)}\n--- stdout head ---\n${(res.stdout || '').slice(0, 600)}\n`);
    process.exitCode = 1;
    return;
  }
  const evs = (res.stdout || '').split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (evs.some(e => e.type === 'user.message' && e.data?.content === '')) {
    const servers = [...new Set(evs.filter(e => e.type === 'session.mcp_server_status_changed').map(e => e.data?.serverName).filter(Boolean))];
    process.stderr.write(`WARN: copilot appended an EMPTY user turn (MCP server connected after the prompt — copilot -p bug); ` +
      `the model may echo junk instead of answering.\n` +
      `      Workaround: WORKFLOW_AGENT_ARGS="--disable-mcp-server <slow server>" (this run saw: ${servers.join(', ') || 'none'})\n`);
  }
  process.stderr.write(
    `parsed text: ${JSON.stringify(res.text.slice(0, 120))}\n` +
    `tokens: ${res.tokens} (${res.usageReal ? 'REAL usage parsed from copilot output' : 'ESTIMATE chars/4 — no usage field found; paste the raw head below to fix the parser'})\n` +
    `--- raw stdout head ---\n${(res.stdout || '').slice(0, 1500)}\n`);
}

const { flags, pos } = parseCliArgs(process.argv.slice(2));
const cmd = pos.shift();
if (cmd === 'run') await cmdRun({ flags, pos });
else if (cmd === 'list') cmdList({ flags });
else if (cmd === 'journal') cmdJournal({ flags, pos });
else if (cmd === 'watch') await cmdWatch({ flags, pos });
else if (cmd === 'doctor') await cmdDoctor();
else die('usage: engine.mjs <run|list|journal|watch|doctor> …');
