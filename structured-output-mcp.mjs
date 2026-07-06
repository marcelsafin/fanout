#!/usr/bin/env node
// Minimal stdio MCP server exposing ONE tool: StructuredOutput.
// The Claude Code Workflow equivalent: schema enforcement at the tool-call layer
// instead of prompt-and-parse. The engine loads this per schema-agent via
// copilot --additional-mcp-config; the tool's inputSchema IS the workflow schema,
// and a call writes the arguments as JSON to $WF_OUT for the engine to pick up.
// Zero deps, newline-delimited JSON-RPC 2.0.
import fs from 'node:fs';
import readline from 'node:readline';

const OUT = process.env.WF_OUT;
let schema = { type: 'object' };
try { schema = JSON.parse(fs.readFileSync(process.env.WF_SCHEMA, 'utf8')); } catch {}

const send = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const rl = readline.createInterface({ input: process.stdin });

rl.on('line', line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: msg.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'workflow-output', version: '1.0.0' },
    } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{
      name: 'StructuredOutput',
      description: 'REQUIRED final step: submit your result as structured data. ' +
        'Call this exactly once with your complete answer; its arguments are the return value of this task.',
      inputSchema: schema,
    }] } });
  } else if (msg.method === 'tools/call') {
    if (msg.params?.name === 'StructuredOutput') {
      try { fs.writeFileSync(OUT, JSON.stringify(msg.params.arguments ?? null)); } catch {}
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Result recorded. You are done — end the turn now.' }] } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool' } });
    }
  } else if (msg.id != null) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} }); // ping etc.
  } // notifications (no id): ignore
});
