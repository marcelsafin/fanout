export const meta = {
  name: 'caps-test',
  description: 'item cap: 4097 items into pipeline/parallel is an explicit error',
}
let pipeErr = null, parErr = null
try { await pipeline(Array.from({ length: 4097 }, (_, i) => i), x => x) } catch (e) { pipeErr = e.message }
try { await parallel(Array.from({ length: 4097 }, () => () => 1)) } catch (e) { parErr = e.message }
return { pipeErr, parErr }
