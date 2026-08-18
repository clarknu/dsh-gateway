// Bisect: run the plugin's own gateway-core exactly as the plugin does.
import { createGateway } from '../lib/gateway-core.js'
import https from 'node:https'

const gateway = createGateway({
  listenHost: '127.0.0.1',
  port: 0,
  upstream: 'http://127.0.0.1:3081',
  users: { admin: 'change-me' },
  sites: [{ hosts: ['localhost', '127.0.0.1'] }],
  certsDir: 'C:/Users/Clark Nu/.dsh/gateway/certs',
  hmacSecret: 'x'.repeat(32),
  log: (m) => console.log(m),
  warn: (m) => console.log(m),
})
const port = await gateway.start()
console.log('gateway on', port)
for (const sn of ['localhost', '127.0.0.1', undefined]) {
  const opts = { host: '127.0.0.1', port, rejectUnauthorized: false, path: '/login', headers: { host: '127.0.0.1' } }
  if (sn !== undefined) opts.servername = sn
  const result = await new Promise((resolve) => {
    const r = https.request(opts, (res) => { res.resume(); res.on('end', () => resolve(`status ${res.statusCode}`)) })
    r.on('error', (e) => resolve(`ERR ${e.code} ${e.message}`))
    r.end()
  })
  console.log(`servername=${JSON.stringify(sn)}: ${result}`)
}
gateway.stop()
