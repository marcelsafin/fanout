export const meta = {
  name: 'resume-test',
  description: 'two sequential agents — used to verify prefix caching on resume',
}
const a = await agent('STUB_UPPER:first')
const b = await agent('STUB_UPPER:second')
return { a, b }
