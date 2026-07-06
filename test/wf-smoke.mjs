export const meta = {
  name: 'smoke',
  description: 'pipeline no-barrier, parallel null-on-throw, phase/log, determinism guards',
  phases: [{ title: 'Map' }, { title: 'Check' }],
}
phase('Map')
// pipeline: 3 items × 2 stages; stage 2 uses (prev, originalItem, index)
const mapped = await pipeline(
  ['alpha', 'beta', 'gamma'],
  item => agent(`STUB_UPPER:${item}`, { label: `up:${item}`, phase: 'Map' }),
  (prev, item, i) => `${i}:${item}->${prev}`,
)

phase('Check')
// parallel: throwing thunk resolves to null, call never rejects
const par = await parallel([
  () => agent('plain question'),
  () => { throw new Error('thunk exploded') },
  () => agent('STUB_FAIL should retry then null', { label: 'failer' }),
])

// determinism guards throw inside the script realm
let dateErr = null, randErr = null
try { Date.now() } catch (e) { dateErr = e.message }
try { Math.random() } catch (e) { randErr = e.message }
const okDate = new Date(0).getTime() === 0   // new Date(x) still allowed

log(`mapped=${mapped.length} par=${par.length}`)
return { mapped, par, dateErr, randErr, okDate, args }
