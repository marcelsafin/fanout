export const meta = {
  name: 'wf-url',
  description: 'sandbox exposes URL/URLSearchParams (Node globals, not intrinsics)',
}
const u = new URL('https://www.Example.com/path/?q=1')
return { host: u.hostname, q: new URLSearchParams(u.search).get('q') }
