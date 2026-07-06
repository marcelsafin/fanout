export const meta = {
  name: 'wf-dup',
  description: 'two identical agent() calls: occurrence-keyed cache serves both on resume',
}
const a = await agent('STUB_UPPER:same')
const b = await agent('STUB_UPPER:same')
return { a, b }
