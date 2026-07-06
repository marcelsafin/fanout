export const meta = {
  name: 'budget-test',
  description: 'budget is a hard ceiling: agent() throws once spent >= total',
}
const first = await agent('STUB_LONG give me lots of text')  // ~100 tokens > tiny budget
let threw = null
try { await agent('this must be refused') } catch (e) { threw = e.message }
return { firstLen: first.length, spent: budget.spent(), total: budget.total, remaining: budget.remaining(), threw }
