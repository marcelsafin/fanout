export const meta = {
  name: 'child',
  description: 'child workflow: one agent + verifies second-level nesting throws',
}
const up = await agent(`STUB_UPPER:${args.greeting}`)
let nestErr = null
try { await workflow({ scriptPath: 'wf-child.mjs' }) } catch (e) { nestErr = e.message }
return { up, nestErr }
