// Real-world WS probe through the gateway against the DSH web app's actual
// upgrade routes (/api/events.mux).
import https from 'node:https'
import { parse } from 'node:querystring'

const PORT = 3443

// 1) log in and capture the session cookie
const cookie = await new Promise((resolve, reject) => {
  const body = 'username=admin&password=change-me'
  const req = https.request(
    { host: '127.0.0.1', port: PORT, servername: 'localhost', rejectUnauthorized: false, method: 'POST', path: '/login', headers: { host: 'localhost', 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } },
    (res) => {
      const sc = (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ')
      res.resume()
      res.on('end', () => { console.log(`login response: HTTP ${res.statusCode}`); resolve(sc) })
    },
  )
  req.on('error', reject)
  req.write(body)
  req.end()
})
console.log('cookie acquired:', cookie ? 'yes' : 'NO')

function probe(withCookie) {
  return new Promise((resolve) => {
    const headers = {
      host: 'localhost',
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'sec-websocket-key': Buffer.from('probe-123').toString('base64'),
      'sec-websocket-version': '13',
    }
    if (withCookie) headers.cookie = cookie
    const req = https.request(
      { host: '127.0.0.1', port: PORT, servername: 'localhost', rejectUnauthorized: false, path: '/api/events.mux', headers },
      () => {},
    )
    const timer = setTimeout(() => { req.destroy(); resolve('timeout') }, 5000)
    req.on('upgrade', (res, socket) => {
      clearTimeout(timer)
      const sec = res.headers['sec-websocket-accept']
      socket.destroy()
      resolve(`101 upgraded${sec ? ' (sec-websocket-accept ok)' : ' (NO accept header!)'}`)
    })
    req.on('response', (res) => {
      clearTimeout(timer)
      res.resume()
      res.on('end', () => resolve(`HTTP ${res.statusCode}`))
    })
    req.on('error', (e) => { clearTimeout(timer); resolve(`ERR ${e.code}`) })
    req.end()
  })
}

console.log('unauthenticated /api/events.mux upgrade ->', await probe(false))
console.log('authenticated   /api/events.mux upgrade ->', await probe(true))
