export const meta = {
  name: 'max-probe',
  description: 'Architecture probe: concurrency cap, pipeline overlap, schema enforcement, effort/model overrides, budget accounting',
  phases: [
    { title: 'Fanout', detail: '8 parallel agents vs concurrency cap — queueing visible in journal timings' },
    { title: 'Pipeline', detail: '3 items x 2 stages, no barrier — overlap visible in timings' },
    { title: 'Schema', detail: 'structured output enforced against the live model' },
    { title: 'Tuning', detail: 'same task at effort low vs high + model auto' },
  ],
}

phase('Fanout')
const WORDS = ['alfa', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']
const fan = await parallel(WORDS.map((w) => () =>
  agent(`Return ONLY the uppercase of the word: ${w}`, { label: `fan:${w}`, phase: 'Fanout' })))
const fanOk = fan.filter((r, i) => typeof r === 'string' && r.includes(WORDS[i].toUpperCase())).length
log(`fanout: ${fanOk}/${WORDS.length} correct`)

phase('Pipeline')
const piped = await pipeline(
  ['röd', 'grön', 'blå'],
  (item, _o, i) => agent(`Translate the Swedish color word "${item}" to English. Return ONLY the English word, lowercase.`, { label: `sv-en:${i}`, phase: 'Pipeline' }),
  (prev, item, i) => agent(`Return ONLY the number of letters in the word: ${prev}`, { label: `len:${i}`, phase: 'Pipeline' }),
)
log(`pipeline: ${JSON.stringify(piped)}`)

phase('Schema')
const SCHEMA = {
  type: 'object', required: ['bugs'],
  properties: {
    bugs: {
      type: 'array',
      items: {
        type: 'object', required: ['line', 'severity', 'description'],
        properties: {
          line: { type: 'integer' },
          severity: { enum: ['low', 'medium', 'high'] },
          description: { type: 'string' },
        },
      },
    },
  },
}
const review = await agent(
  'Find the bugs in this JS function:\n' +
  'function avg(xs) {\n  let sum;\n  for (let i = 0; i <= xs.length; i++) sum += xs[i];\n  return sum / xs.length;\n}',
  { label: 'schema-review', phase: 'Schema', schema: SCHEMA })
log(`schema: ${review ? review.bugs.length + ' bugs, validated' : 'FAILED validation after retries'}`)

phase('Tuning')
const RIDDLE = 'A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Return ONLY the number.'
const [effLow, effHigh, modelAuto] = await parallel([
  () => agent(RIDDLE, { label: 'effort:low', phase: 'Tuning', effort: 'low' }),
  () => agent(RIDDLE, { label: 'effort:high', phase: 'Tuning', effort: 'high' }),
  () => agent(RIDDLE, { label: 'model:auto', phase: 'Tuning', model: 'auto' }),
])

return {
  fanout: { correct: fanOk, of: WORDS.length, replies: fan },
  pipeline: piped,
  schema: review,
  tuning: { effortLow: effLow, effortHigh: effHigh, modelAuto: modelAuto, expected: '9' },
  spentTokens: budget.spent(),
}
