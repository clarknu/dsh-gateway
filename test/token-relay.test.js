// Process-token relay: when the dsh web answers 401 to a document navigation,
// the gateway answers with a 302 to /?token=<this process's launch token> so
// the browser completes the dsh session handshake transparently.
//
// The upstream here is a scriptable fake: it reproduces only the bits of the
// dsh web that matter (401 for an unauthenticated document, a token exchange
// that mints a SameSite=Strict cookie, 200 for a valid cookie), so the relay
// conditions can be driven exactly — no real dsh process involved.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import https from 'node:https'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGateway } from '../lib/gateway-core.js'

const noLog = () => {}
const HMAC = 'test-secret-test-secret-test-secret-32'

// ---------- fake upstream ----------

/** A dsh-like upstream: 401 on the document unless the session cookie is sent. */
function makeDshUpstream({ token, authCookie = 'dsh-auth-VPhEEcLKeqRDBoBalzN2Nm7CnfxKhLE00pKIDWxt1sw', htmlBytes = 28778 } = {}) {
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://up.invalid')
    const sent = String(req.headers.cookie ?? '')
    if (url.pathname === '/' && url.searchParams.get('token') === token) {
      // authorizeIndex(): mint the browser session cookie, 303 to clean '/'.
      res.writeHead(303, {
        location: '/',
        'set-cookie': `${authCookie}=v1.payload; Path=/; HttpOnly; SameSite=Strict`,
      })
      res.end()
      return
    }
    if (sent.includes(authCookie)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('x'.repeat(htmlBytes))
      return
    }
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('dsh web authentication required; reopen the URL printed by dsh web.')
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/** An upstream that answers every request with 401 (for the relay conditions). */
function makeAlways401() {
  const server = createHttpServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('dsh web authentication required; reopen the URL printed by dsh web.')
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

// ---------- gateway + https client helpers ----------

/** Start a gateway in front of `upstream` and hand it to `fn`; always torn down. */
async function withGateway(upstream, overrides, fn) {
  const upstreamPort = upstream.address().port
  const certsDir = mkdtempSync(join(tmpdir(), 'dshgw-relay-'))
  const opts = Object.assign(
    {
      listenHost: '127.0.0.1',
      port: 0,
      upstream: `http://127.0.0.1:${upstreamPort}`,
      users: { admin: 'secret-pass' },
      sites: [{ hosts: ['localhost'] }],
      certsDir,
      hmacSecret: HMAC,
      log: noLog,
      warn: noLog,
    },
    overrides,
  )
  const gateway = createGateway(opts)
  const port = await gateway.start()
  try {
    await fn({ port, opts })
  } finally {
    gateway.stop()
    upstream.close()
  }
}

/** One HTTPS request; returns status, headers (lowercased), body, setCookies. */
function request(port, { host = 'localhost', method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false, method, path, headers: { host, ...headers } },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (raw += c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, setCookies: res.headers['set-cookie'] ?? [], body: raw }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** POST /login with the test credentials; returns the gateway session cookies. */
function postLogin(port) {
  return new Promise((resolve, reject) => {
    const body = 'username=admin&password=secret-pass'
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        servername: 'localhost',
        rejectUnauthorized: false,
        method: 'POST',
        path: '/login',
        headers: { host: 'localhost', 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, setCookies: res.headers['set-cookie'] ?? [] }))
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

const gwCookieOf = (setCookies) => setCookies.map((c) => c.split(';')[0]).join('; ')

const TOKEN = 'ProbeToken1234567890abcdef'

// ---------- relay conditions ----------

test('401 on a document navigation relays to /?token=… and sets the marker cookie', async () => {
  const upstream = await makeAlways401()
  await withGateway(upstream, { resolveWebToken: () => TOKEN }, async ({ port }) => {
    const login = await postLogin(port)
    const gw = gwCookieOf(login.setCookies)
    const res = await request(port, { path: '/', headers: { cookie: gw, 'sec-fetch-mode': 'navigate', accept: 'text/html' } })
    assert.equal(res.status, 302)
    assert.equal(res.headers.location, `/?token=${TOKEN}`)
    const marker = res.setCookies.find((c) => c.startsWith('dsh_gw_relay='))
    assert.ok(marker, 'expected the dsh_gw_relay marker cookie')
    assert.match(marker, /Max-Age=60/)
    assert.match(marker, /Path=\//)
    assert.match(marker, /HttpOnly/)
    assert.match(marker, /SameSite=Lax/)
    assert.match(marker, /Secure/)
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.equal(res.headers['referrer-policy'], 'no-referrer')
  })
})

test('an existing marker cookie suppresses the relay — the 401 reaches the browser (no loop)', async () => {
  const upstream = await makeAlways401()
  await withGateway(upstream, { resolveWebToken: () => TOKEN }, async ({ port }) => {
    const login = await postLogin(port)
    const gw = gwCookieOf(login.setCookies)
    // Second hop: the browser now carries the marker set by the first relay.
    const res = await request(port, { path: '/', headers: { cookie: `${gw}; dsh_gw_relay=1`, 'sec-fetch-mode': 'navigate', accept: 'text/html' } })
    assert.equal(res.status, 401)
    assert.equal(res.headers.location, undefined)
    assert.equal(res.setCookies.length, 0)
    assert.match(res.body, /dsh web authentication required/)
  })
})

test('non-document requests are never relayed (sec-fetch-mode / Accept)', async () => {
  const upstream = await makeAlways401()
  await withGateway(upstream, { resolveWebToken: () => TOKEN }, async ({ port }) => {
    const login = await postLogin(port)
    const gw = gwCookieOf(login.setCookies)
    const cors = await request(port, { path: '/', headers: { cookie: gw, 'sec-fetch-mode': 'cors', accept: '*/*' } })
    assert.equal(cors.status, 401)
    assert.equal(cors.headers.location, undefined)
    const json = await request(port, { path: '/', headers: { cookie: gw, accept: 'application/json' } })
    assert.equal(json.status, 401)
    assert.equal(json.headers.location, undefined)
    const wildcard = await request(port, { path: '/', headers: { cookie: gw, accept: '*/*' } })
    assert.equal(wildcard.status, 401)
  })
})

test('a request already carrying ?token= is not relayed again', async () => {
  const upstream = await makeAlways401()
  await withGateway(upstream, { resolveWebToken: () => TOKEN }, async ({ port }) => {
    const login = await postLogin(port)
    const gw = gwCookieOf(login.setCookies)
    const res = await request(port, { path: `/?token=${TOKEN}`, headers: { cookie: gw, 'sec-fetch-mode': 'navigate', accept: 'text/html' } })
    assert.equal(res.status, 401)
    assert.equal(res.headers.location, undefined)
  })
})

test('an unavailable or throwing resolveWebToken degrades to the plain 401', async () => {
  for (const resolveWebToken of [() => null, () => undefined, () => '', () => { throw new Error('connection service gone') }, undefined]) {
    const upstream = await makeAlways401()
    await withGateway(upstream, { resolveWebToken }, async ({ port }) => {
      const login = await postLogin(port)
      const gw = gwCookieOf(login.setCookies)
      const res = await request(port, { path: '/', headers: { cookie: gw, 'sec-fetch-mode': 'navigate', accept: 'text/html' } })
      assert.equal(res.status, 401)
      assert.equal(res.headers.location, undefined)
      assert.equal(res.setCookies.length, 0)
    })
  }
})

test('a non-GET document request is not relayed', async () => {
  const upstream = await makeAlways401()
  await withGateway(upstream, { resolveWebToken: () => TOKEN }, async ({ port }) => {
    const login = await postLogin(port)
    const gw = gwCookieOf(login.setCookies)
    const res = await request(port, { method: 'POST', path: '/', headers: { cookie: gw, 'sec-fetch-mode': 'navigate', accept: 'text/html' } })
    assert.equal(res.status, 401)
    assert.equal(res.headers.location, undefined)
  })
})

test('the relay is read live from options (hot-reload picks up a new token)', async () => {
  const upstream = await makeAlways401()
  await withGateway(upstream, { resolveWebToken: () => 'old-token' }, async ({ port, opts }) => {
    const login = await postLogin(port)
    const gw = gwCookieOf(login.setCookies)
    const first = await request(port, { path: '/', headers: { cookie: gw, 'sec-fetch-mode': 'navigate' } })
    assert.equal(first.headers.location, '/?token=old-token')
    // The plugin hot reload Object.assigns over the same options object.
    Object.assign(opts, { resolveWebToken: () => 'new-token' })
    const second = await request(port, { path: '/', headers: { cookie: gw, 'sec-fetch-mode': 'navigate' } })
    assert.equal(second.headers.location, '/?token=new-token')
  })
})

test('unauthenticated gateway clients still go to /login, never to the token relay', async () => {
  const upstream = await makeAlways401()
  await withGateway(upstream, { resolveWebToken: () => TOKEN }, async ({ port }) => {
    const res = await request(port, { path: '/', headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' } })
    assert.equal(res.status, 302)
    assert.equal(res.headers.location, '/login')
  })
})

test('relay diagnostics fire at most once each (relayed / token unavailable)', async () => {
  // The "relayed" line proves the relay ran; the "unavailable" line separates a
  // plugin-side token lookup failure from the relay never being reached.
  const logs = []
  const warnings = []
  const upstream = await makeAlways401()
  await withGateway(upstream, { resolveWebToken: () => TOKEN, log: (m) => logs.push(m), warn: (m) => warnings.push(m) }, async ({ port }) => {
    const login = await postLogin(port)
    const gw = gwCookieOf(login.setCookies)
    for (let i = 0; i < 2; i++) {
      await request(port, { path: '/', headers: { cookie: gw, 'sec-fetch-mode': 'navigate' } })
    }
    assert.equal(logs.filter((m) => /relayed the dsh process token/.test(m)).length, 1)
    assert.equal(warnings.filter((m) => /process token not resolved/.test(m)).length, 0)
  })

  const logs2 = []
  const warnings2 = []
  const upstream2 = await makeAlways401()
  await withGateway(upstream2, { resolveWebToken: () => null, log: (m) => logs2.push(m), warn: (m) => warnings2.push(m) }, async ({ port }) => {
    const login = await postLogin(port)
    const gw = gwCookieOf(login.setCookies)
    for (let i = 0; i < 2; i++) {
      await request(port, { path: '/', headers: { cookie: gw, 'sec-fetch-mode': 'navigate' } })
    }
    assert.equal(warnings2.filter((m) => /process token not resolved/.test(m)).length, 1)
    assert.equal(logs2.filter((m) => /relayed the dsh process token/.test(m)).length, 0)
  })
})

// ---------- end-to-end: login → relay → exchange → 200 ----------

test('full chain: gateway login → relay → dsh token exchange → 200 html', async () => {
  const upstream = await makeDshUpstream({ token: TOKEN })
  await withGateway(upstream, { resolveWebToken: () => TOKEN }, async ({ port }) => {
    // 1. Gateway login.
    const login = await postLogin(port)
    assert.equal(login.status, 302)
    const gw = gwCookieOf(login.setCookies)
    assert.match(gw, /^dsh_gw_sid=/)
    const jar = [gw]

    // 2. The dsh web has no session for this browser yet → 401 → relay.
    const first = await request(port, { path: '/', headers: { cookie: jar.join('; '), 'sec-fetch-mode': 'navigate', accept: 'text/html' } })
    assert.equal(first.status, 302)
    assert.equal(first.headers.location, `/?token=${TOKEN}`)
    jar.push(first.setCookies.find((c) => c.startsWith('dsh_gw_relay=')).split(';')[0])

    // 3. Follow the relay: the upstream mints dsh-auth-* and the gateway makes
    //    the cookie browser-compatible through HTTPS (T-009 behaviour).
    const exchange = await request(port, { path: first.headers.location, headers: { cookie: jar.join('; '), 'sec-fetch-mode': 'navigate', accept: 'text/html' } })
    assert.equal(exchange.status, 303)
    assert.equal(exchange.headers.location, '/')
    const auth = exchange.setCookies.find((c) => c.startsWith('dsh-auth-'))
    assert.ok(auth, 'expected the dsh-auth-* session cookie from the token exchange')
    assert.match(auth, /SameSite=Lax/i)
    assert.doesNotMatch(auth, /SameSite=Strict/i)
    assert.match(auth, /;\s*Secure\b/i)
    jar.push(auth.split(';')[0])

    // 4. The browser now holds both cookies: the document loads.
    const page = await request(port, { path: '/', headers: { cookie: jar.join('; '), 'sec-fetch-mode': 'navigate', accept: 'text/html' } })
    assert.equal(page.status, 200)
    assert.match(page.headers['content-type'], /text\/html/)
    assert.ok(page.body.length > 20000 && page.body.length < 40000, `expected a full index page, got ${page.body.length} bytes`)
  })
})
