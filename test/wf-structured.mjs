export const meta = {
  name: 'wf-structured',
  description: 'schema agent: StructuredOutput file wins over text parse',
}
const r = await agent('STUB_MCP_FILE', {
  schema: { type: 'object', required: ['via', 'n'], properties: { via: { type: 'string' }, n: { type: 'integer' } } },
})
return { r }
