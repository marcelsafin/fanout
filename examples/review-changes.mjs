// Canonical multi-stage review: pipeline by default — each dimension's findings
// verify as soon as its review completes. Run from the repo you want reviewed:
//   node ~/.copilot/skills/fanout/engine.mjs run \
//     ~/.copilot/skills/fanout/examples/review-changes.mjs -C . --args '"HEAD~1..HEAD"'
export const meta = {
  name: 'review-changes',
  description: 'Review a git range across dimensions, adversarially verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const range = typeof args === 'string' ? args : 'HEAD~1..HEAD'

const FINDINGS_SCHEMA = {
  type: 'object', required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', required: ['title', 'file', 'detail'],
        properties: { title: { type: 'string' }, file: { type: 'string' }, line: { type: 'integer' }, detail: { type: 'string' } },
      },
    },
  },
}
const VERDICT_SCHEMA = {
  type: 'object', required: ['isReal', 'reason'],
  properties: { isReal: { type: 'boolean' }, reason: { type: 'string' } },
}

const DIMENSIONS = [
  { key: 'bugs', prompt: `Review the diff of git range ${range} in this repo for CORRECTNESS bugs only (logic errors, wrong conditions, broken edge cases). Inspect the diff with git. Report real defects, not style.` },
  { key: 'security', prompt: `Review the diff of git range ${range} in this repo for SECURITY issues only (injection, authz, secrets, unsafe deserialization).` },
  { key: 'perf', prompt: `Review the diff of git range ${range} in this repo for PERFORMANCE regressions only (N+1, sync-over-async, unbounded growth).` },
]

const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA }),
  (review, d) => parallel((review?.findings ?? []).map(f => () =>
    agent(
      `Adversarially verify this ${d.key} finding — try to REFUTE it by reading the actual code. Finding: ${f.title} in ${f.file}: ${f.detail}. Default to isReal=false if uncertain.`,
      { label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA },
    ).then(v => ({ ...f, dimension: d.key, verdict: v })))),
)

const confirmed = results.filter(Boolean).flat().filter(Boolean).filter(f => f.verdict?.isReal)
log(`${confirmed.length} confirmed findings`)
return { range, confirmed }
