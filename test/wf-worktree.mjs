export const meta = {
  name: 'wf-worktree',
  description: 'worktree isolation: clean worktree auto-removed, dirty worktree kept',
}
const clean = await agent('STUB_UPPER:clean', { isolation: 'worktree', label: 'clean' })
const dirty = await agent('STUB_TOUCH', { isolation: 'worktree', label: 'dirty' })
return { clean, dirty }
