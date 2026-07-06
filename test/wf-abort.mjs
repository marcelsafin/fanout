export const meta = {
  name: 'wf-abort',
  description: 'SIGINT mid-run: first agent journaled, resume replays it from cache',
}
const a = await agent('STUB_UPPER:first')
const b = await agent('STUB_SLEEP')
return { a, b }
