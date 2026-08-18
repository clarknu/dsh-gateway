// Standalone gateway tests: a fake loopback upstream (plain HTTP + a
// WebSocket echo) behind a real createGateway instance, exercised over TLS
// with rejectUnauthorized disabled (the certs are self-signed by design).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import https from 'node:https'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import selfsigned from 'selfsigned'
import { createGateway } from '../lib/gateway-core.js'

// ---------- fake upstream ----------

function makeUpstream() {
  const upstream = createHttpServer((req, res) => {
    if (req.url.startsWith('/api/echo')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ url: req.url, xfp: req.headers['x-forwarded-proto'] ?? null, host: req.headers.host }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('upstream-ok')
  })
  upstream.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (chunk) => socket.write(chunk))
  })
  return new Promise((resolve) => {
    upstream.listen(0, '127.0.0.1', () => resolve(upstream))
  })
}

// ---------- gateway + https client helpers ----------

const noLog = () => {}

async function withGateway(overrides, fn) {
  const upstream = await makeUpstream()
  const upstreamPort = upstream.address().port
  const certsDir = mkdtempSync(join(tmpdir(), 'dshgw-'))
  const opts = Object.assign(
    {
      listenHost: '127.0.0.1',
      port: 0,
      upstream: `http://127.0.0.1:${upstreamPort}`,
      users: { admin: 'secret-pass', clark: 'other-pass' },
      sites: [{ hosts: ['localhost', 'a.test'] }],
      certsDir,
      hmacSecret: 'test-secret-test-secret-test-secret-32',
    },
    overrides,
  )
  const gateway = createGateway(opts)
  const port = await gateway.start()
  try {
    await fn({ gateway, port, upstreamPort, opts })
  } finally {
    gateway.stop()
    upstream.close()
  }
}

/** One HTTPS request; returns status, headers (lowercased), body, setCookies. */
function request(port, { host = 'localhost', servername = 'localhost', method = 'GET', path = '/', headers = {}, body = null, expectUpgrade = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port, servername, rejectUnauthorized: false, method, path, headers: { host, ...headers } },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (raw += c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, setCookies: res.headers['set-cookie'] ?? [], body: raw }))
      },
    )
    req.on('error', reject)
    if (expectUpgrade) {
      req.on('upgrade', (res, socket, head) => resolve({ upgraded: true, socket, head, status: res.statusCode, headers: res.headers }))
      req.on('response', (res) => resolve({ upgraded: false, status: res.statusCode, headers: res.headers }))
    }
    if (body) req.write(body)
    req.end()
  })
}

function cookieOf(setCookies) {
  return setCookies.map((c) => c.split(';')[0]).join('; ')
}

// ---------- tests ----------

test('unauthenticated request redirects to /login', async () => {
  await withGateway({}, async ({ port }) => {
    const res = await request(port, { path: '/' })
    assert.equal(res.status, 302)
    assert.equal(res.headers.location, '/login')
  })
})

test('SNI-less TLS handshake works (IP-literal clients, e.g. browsers on https://192.168.x.x)', async () => {
  await withGateway({}, async ({ port }) => {
    // No servername option at all: the client sends no SNI extension, exactly
    // like a browser connecting to an IP literal.
    const res = await new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port, rejectUnauthorized: false, path: '/', headers: { host: 'localhost' } }, (r) => {
        let body = ''
        r.setEncoding('utf8')
        r.on('data', (c) => (body += c))
        r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body }))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(res.status, 302)
    assert.equal(res.headers.location, '/login')
  })
})

test('login page renders localized content', async () => {
  await withGateway({}, async ({ port }) => {
    const zh = await request(port, { path: '/login', headers: { 'accept-language': 'zh-CN,zh;q=0.9' } })
    assert.equal(zh.status, 200)
    assert.match(zh.body, /访问认证|请输入访问凭据/)
    const en = await request(port, { path: '/login', headers: { 'accept-language': 'en-US' } })
    assert.equal(en.status, 200)
    assert.match(en.body, /Sign in/)
  })
})

test('login rejects bad credentials and locks after repeated failures', async () => {
  await withGateway({ loginFailLimit: 3 }, async ({ port }) => {
    for (let i = 0; i < 3; i++) {
      const res = await request(port, { method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=wrong' })
      assert.equal(res.status, 401)
    }
    const locked = await request(port, { method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=secret-pass' })
    assert.equal(locked.status, 429)
    assert.ok(locked.headers['retry-after'])
  })
})

test('successful login issues an HttpOnly Secure session cookie that authorizes proxying', async () => {
  await withGateway({}, async ({ port, upstreamPort }) => {
    const login = await request(port, { method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=secret-pass' })
    assert.equal(login.status, 302)
    assert.equal(login.headers.location, '/')
    const cookie = cookieOf(login.setCookies)
    assert.match(cookie, /^dsh_gw_sid=/)
    assert.match(login.setCookies[0], /HttpOnly/)
    assert.match(login.setCookies[0], /Secure/)
    assert.match(login.setCookies[0], /SameSite=Lax/)

    const proxied = await request(port, { path: '/', headers: { cookie } })
    assert.equal(proxied.status, 200)
    assert.equal(proxied.body, 'upstream-ok')

    const api = await request(port, { path: '/api/echo?x=1', headers: { cookie } })
    assert.equal(api.status, 200)
    const json = JSON.parse(api.body)
    assert.equal(json.xfp, 'https')
    assert.equal(json.host, `127.0.0.1:${upstreamPort}`) // upstream Host header was rewritten
  })
})

test('logout clears the browser session cookie', async () => {
  await withGateway({}, async ({ port }) => {
    const login = await request(port, { method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=secret-pass' })
    const out = await request(port, { path: '/logout', headers: { cookie: cookieOf(login.setCookies) } })
    assert.equal(out.status, 302)
    assert.equal(out.headers.location, '/login')
    assert.match(out.setCookies[0], /Max-Age=0/)
    assert.match(out.setCookies[0], /dsh_gw_sid=;/)
    // Sessions are stateless (HMAC-signed), so the browser-side clear is the
    // logout; the cleared cookie value is what a following request carries.
    const after = await request(port, { path: '/', headers: { cookie: 'dsh_gw_sid=' } })
    assert.equal(after.status, 302)
  })
})

test('a user removed from the table loses access immediately (live config)', async () => {
  const users = { admin: 'secret-pass', clark: 'other-pass' }
  await withGateway({ users }, async ({ port }) => {
    const login = await request(port, { method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=clark&password=other-pass' })
    const cookie = cookieOf(login.setCookies)
    assert.equal((await request(port, { path: '/', headers: { cookie } })).status, 200)
    // The plugin hot-reload mutates the shared options object; the auth table
    // is read per request, so removing the user takes effect immediately.
    delete users.clark
    assert.equal((await request(port, { path: '/', headers: { cookie } })).status, 302)
  })
})

test('replacing the whole users table live (the plugin Object.assign path) applies immediately', async () => {
  await withGateway({ users: { admin: 'old-pass' } }, async ({ port, opts }) => {
    const bad = await request(port, { method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=new-pass' })
    assert.equal(bad.status, 401)
    // The plugin assigns a fresh options value over the same object reference.
    Object.assign(opts, { users: { admin: 'new-pass' }, sessionDays: 45 })
    const good = await request(port, { method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=new-pass' })
    assert.equal(good.status, 302)
    assert.match(good.setCookies[0], /Max-Age=3888000/) // 45 days
  })
})

test('unknown Host header is refused with 421', async () => {
  await withGateway({}, async ({ port }) => {
    const res = await request(port, { host: 'evil.example.com', servername: 'evil.example.com', path: '/' })
    assert.equal(res.status, 421)
  })
})

test('unauthenticated WebSocket upgrade is refused', async () => {
  await withGateway({}, async ({ port }) => {
    const res = await request(port, {
      path: '/ws',
      expectUpgrade: true,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'sec-websocket-key': 'AAAA', 'sec-websocket-version': '13' },
    })
    assert.equal(res.upgraded, false)
    assert.equal(res.status, 302)
  })
})

test('authenticated WebSocket upgrade proxies and echoes', async () => {
  await withGateway({}, async ({ port }) => {
    const login = await request(port, { method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=secret-pass' })
    const cookie = cookieOf(login.setCookies)
    const res = await request(port, {
      path: '/ws',
      expectUpgrade: true,
      headers: { cookie, Connection: 'Upgrade', Upgrade: 'websocket', 'sec-websocket-key': 'BBBB', 'sec-websocket-version': '13' },
    })
    assert.equal(res.upgraded, true)
    const echoed = await new Promise((resolve, reject) => {
      res.socket.setEncoding('utf8')
      res.socket.once('data', (d) => resolve(d))
      res.socket.once('error', reject)
      res.socket.write('ping-from-client')
      setTimeout(() => reject(new Error('no echo in time')), 3000)
    })
    assert.equal(echoed, 'ping-from-client')
    res.socket.destroy()
  })
})

test('unreachable upstream yields 502', async () => {
  const certsDir = mkdtempSync(join(tmpdir(), 'dshgw2-'))
  const gateway = createGateway({
    listenHost: '127.0.0.1',
    port: 0,
    upstream: 'http://127.0.0.1:1',
    users: { admin: 'x' },
    sites: [{ hosts: ['localhost'] }],
    certsDir,
    hmacSecret: 'test-secret-test-secret-test-secret-32',
    log: noLog,
    warn: noLog,
  })
  const port = await gateway.start()
  try {
    const login = await request(port, { method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=x' })
    const cookie = cookieOf(login.setCookies)
    const res = await request(port, { path: '/', headers: { cookie } })
    assert.equal(res.status, 502)
  } finally {
    gateway.stop()
  }
})

test('SNI serves each site its own certificate', async () => {
  const certsDir = mkdtempSync(join(tmpdir(), 'dshgw3-'))
  const gateway = createGateway({
    listenHost: '127.0.0.1',
    port: 0,
    upstream: 'http://127.0.0.1:1',
    users: { admin: 'x' },
    sites: [
      { hosts: ['a.test'] },
      { hosts: ['b.test'] },
    ],
    certsDir,
    hmacSecret: 'test-secret-test-secret-test-secret-32',
    log: noLog,
    warn: noLog,
  })
  const port = await gateway.start()
  try {
    const cnFor = (servername) =>
      new Promise((resolve, reject) => {
        const req = https.request({ host: '127.0.0.1', port, servername, rejectUnauthorized: false, path: '/', headers: { host: servername } }, (res) => {
          const peer = res.socket.getPeerCertificate()
          res.resume()
          res.on('end', () => resolve(peer.subject?.CN ?? null))
        })
        req.on('error', reject)
        req.end()
      })
    assert.equal(await cnFor('b.test'), 'b.test') // auto self-signed per site
    assert.equal(await cnFor('unknown.test'), 'a.test') // default context = first site
  } finally {
    gateway.stop()
  }
})

test('a configured certificate pair is loaded from disk', async () => {
  const { writeFileSync } = await import('node:fs')
  const pems = selfsigned.generate([{ name: 'commonName', value: 'wan.example.net' }], { days: 30, keySize: 2048 })
  const dir = mkdtempSync(join(tmpdir(), 'dshgw4-'))
  const crt = join(dir, 'fullchain.crt')
  const key = join(dir, 'priv.key')
  writeFileSync(crt, pems.cert)
  writeFileSync(key, pems.private)
  const gateway = createGateway({
    listenHost: '127.0.0.1',
    port: 0,
    upstream: 'http://127.0.0.1:1',
    users: { admin: 'x' },
    sites: [{ hosts: ['wan.example.net'], cert: crt, key }],
    certsDir: join(dir, 'certs'),
    hmacSecret: 'test-secret-test-secret-test-secret-32',
    log: noLog,
    warn: noLog,
  })
  const port = await gateway.start()
  try {
    const cn = await new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port, servername: 'wan.example.net', rejectUnauthorized: false, path: '/', headers: { host: 'wan.example.net' } }, (res) => {
        const peer = res.socket.getPeerCertificate()
        res.resume()
        res.on('end', () => resolve(peer.subject?.CN ?? null))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(cn, 'wan.example.net')
    const fp = gateway.defaultCertFingerprint()
    assert.match(fp, /^[0-9A-F:]+$/i)
  } finally {
    gateway.stop()
  }
})
