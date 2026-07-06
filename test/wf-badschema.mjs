export const meta = {
  name: 'wf-badschema',
  description: 'unsupported schema keyword must fail loud, not validate silently',
}
return await agent('STUB_JSON_BUGS', { schema: { type: 'object', patternProperties: { '^x': {} } } })
