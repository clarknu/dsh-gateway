// Real WebSocket upgrade probe through the gateway with browser-like headers.
import https from 'node:https'
import { randomBytes } from 'node:crypto'

const PORT = 3453

const cookie = await new Promise((resolve, reject) => {
  const body = 'username=admin&password=change-me'
  const req = https.request(
    { host: '127.0.0.1', port: PORT, servername: 'localhost', rejectUnauthorized: false, method: 'POST', path: '/login', headers: { host: 'localhost:3453', 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } },
    (res) => {
      const sc = (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ')
      res.resume()
      res.on('end', () => resolve(sc))
    },
  )
  req.on('error', reject)
  req.write(body)
  req.end()
})

const result = await new Promise((resolve) => {
  const req = https.request(
    {
      host: '127.0.0.1',
      port: PORT,
      servername: 'localhost',
      rejectUnauthorized: false,
      path: '/api/events.mux',
      headers: {
        host: 'localhost:3453',
        origin: 'https://localhost:3453',          // browser always sends this on WS
        cookie,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'sec-websocket-key': randomBytes(16).toString('base64'), // RFC 6455: 16 random bytes
        'sec-websocket-version': '13',
        'sec-websocket-protocol': 'mux',
      },
    },
    () => {},
  )
  const timer = setTimeout(() => { req.destroy(); resolve('TIMEOUT (no upgrade response)') }, 6000)
  req.on('upgrade', (res, socket) => {
    clearTimeout(timer)
    const sec = res.headers['sec-websocket-accept']
    socket.destroy()
    resolve(`101 UPGRADED${sec ? ' (sec-websocket-accept ok)' : ' (NO accept header)'}`)
  })
  req.on('response', (res) => {
    clearTimeout(timer)
    let raw = ''
    res.setEncoding('utf8')
    res.on('data', (c) => (raw += c))
    res.on('end', () => resolve(`HTTP ${res.statusCode} body=${JSON.stringify(raw.slice(0, 80))}`))
  })
  req.on('error', (e) => { clearTimeout(timer); resolve(`ERR ${e.code} ${e.message}`) })
  req.end()
})
console.log('WS upgrade through gateway ->', result)
