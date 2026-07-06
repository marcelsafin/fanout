export const meta = {
  name: 'schema-retry',
  description: 'schema-forced output: invalid first reply triggers validation retry',
}
const SCHEMA = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, attempt: { type: 'integer' } } }
const res = await agent('give me STUB_FLAKY_JSON please', { schema: SCHEMA })
const bugs = await agent('find STUB_JSON_BUGS', {
  schema: { type: 'object', required: ['bugs'], properties: { bugs: { type: 'array', items: { type: 'object', required: ['desc'] } } } },
})
return { res, nBugs: bugs.bugs.length }
