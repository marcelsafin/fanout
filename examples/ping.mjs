export const meta = {
  name: 'ping',
  description: 'Self-test: one cheap agent, verifies the copilot backend wiring',
  phases: [{ title: 'Ping' }],
}
phase('Ping')
const reply = await agent('Reply with exactly the single word: PONG', { label: 'ping' })
log(`backend replied: ${reply}`)
return { reply, ok: typeof reply === 'string' && reply.includes('PONG') }
