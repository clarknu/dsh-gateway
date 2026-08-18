// Isolated repro: Node https server with SNICallback + secureContext default.
// Client connects WITHOUT servername (what browsers do for IP literals).
import { createServer } from 'node:https'
import { createSecureContext } from 'node:tls'
import { readFileSync } from 'node:fs'
import https from 'node:https'

const cert = readFileSync('C:/Users/Clark Nu/.dsh/gateway/certs/localhost.crt', 'utf8')
const key = readFileSync('C:/Users/Clark Nu/.dsh/gateway/certs/localhost.key', 'utf8')
const ctx = createSecureContext({ cert, key })

for (const mode of process.argv.slice(2)) {
  const options = {}
  if (mode === 'plain') { options.cert = cert; options.key = key }
  if (mode === 'p+s') { options.cert = cert; options.key = key; options.SNICallback = (servername, cb) => { console.log('SNICallback called with:', JSON.stringify(servername)); cb(null, ctx) } }
  if (mode === 'p+sc') { options.cert = cert; options.key = key; options.secureContext = ctx }
  if (mode === 'snicb') options.SNICallback = (servername, cb) => { console.log('SNICallback called with:', JSON.stringify(servername)); cb(null, ctx) }
  if (mode === 'default') options.secureContext = ctx
  if (mode === 'both') { options.SNICallback = (servername, cb) => { console.log('SNICallback called with:', JSON.stringify(servername)); cb(null, ctx) }; options.secureContext = ctx }
  const server = createServer(options, (req, res) => { res.end('ok') })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const result = await new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port, rejectUnauthorized: false, path: '/', headers: { host: '127.0.0.1' } }, (res) => {
      res.resume(); res.on('end', () => resolve(`status ${res.statusCode}`))
    })
    req.on('error', (e) => resolve(`ERR ${e.code}`))
    req.end()
  })
  console.log(`mode=${mode} (no SNI): ${result}`)
  server.close()
}

// Client sanity: the same SNI-less client against the running Caddy (53443).
if (process.argv.includes('caddy')) {
  const result = await new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port: 53443, rejectUnauthorized: false, path: '/', headers: { host: '192.168.5.5' } }, (res) => {
      res.resume(); res.on('end', () => resolve(`caddy status ${res.statusCode}`))
    })
    req.on('error', (e) => resolve(`caddy ERR ${e.code}`))
    req.end()
  })
  console.log(result)
}

// SNICallback + secureContext, client with EXPLICIT servername variants.
{
  const options = {
    SNICallback: (servername, cb) => { console.log('SNICallback called with:', JSON.stringify(servername)); cb(null, ctx) },
    secureContext: ctx,
  }
  const server = createServer(options, (req, res) => { res.end('ok') })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  for (const servername of ['localhost', '127.0.0.1', undefined]) {
    const result = await new Promise((resolve) => {
      const opts = { host: '127.0.0.1', port, rejectUnauthorized: false, path: '/', headers: { host: '127.0.0.1' } }
      if (servername !== undefined) opts.servername = servername
      const req = https.request(opts, (res) => { res.resume(); res.on('end', () => resolve(`status ${res.statusCode}`)) })
      req.on('error', (e) => resolve(`ERR ${e.code}`))
      req.end()
    })
    console.log(`snicb+default, servername=${JSON.stringify(servername)}: ${result}`)
  }
  server.close()
}
