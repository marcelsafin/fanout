export const meta = {
  name: 'parent',
  description: 'runs a child workflow inline; child shares budget/counters; nesting max 1',
}
const child = await workflow({ scriptPath: 'wf-child.mjs' }, { greeting: 'hej' })
return { child, spentAfterChild: budget.spent() }
