// Proxy teardown guarantees:
//   1. When the client abandons a streamed response, the gateway must tear
//      down its upstream work instead of leaving an orphaned open turn.
//   2. An upstream that accepts a request but never answers must surface as
//      502 after upstreamTimeoutMs, not hang the client indefinitely.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import https from 'node:https'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGateway } from '../lib/gateway-core.js'

const noLog = () => {}

/** Upstream with a slow infinite stream and a never-responding route. */
function makeUpstream() {
  const state = { streamClosedAt: null }
  const server = createHttpServer((req, res) => {
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      const t = setInterval(() => res.write('tick\n'), 100)
      req.on('close', () => {
        clearInterval(t)
        state.streamClosedAt = Date.now()
      })
      return
    }
    if (req.url === '/hang') return // accept, never respond
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('upstream-ok')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state }))
  })
}

function withGateway(overrides, fn) {
  return makeUpstream().then(async ({ server, state }) => {
    const upstreamPort = server.address().port
    const certsDir = mkdtempSync(join(tmpdir(), 'dshgw-'))
    const opts = Object.assign(
      {
        listenHost: '127.0.0.1',
        port: 0,
        upstream: `http://127.0.0.1:${upstreamPort}`,
        users: { admin: 'secret-pass' },
        sites: [{ hosts: ['localhost'] }],
        certsDir,
        hmacSecret: 'test-secret-test-secret-test-secret-32',
      },
      overrides,
    )
    const gateway = createGateway(opts)
    const port = await gateway.start()
    try {
      return await fn({ port, state })
    } finally {
      gateway.stop()
      server.close()
    }
  })
}

/** Raw HTTPS request with manual abort control; resolves on end/error/timeout. */
function rawRequest(port, path, { cookieHeader, abortAfterBytes = 0, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const done = (status) => {
      if (settled) return
      settled = true
      resolve({ status, ms: Date.now() - started })
    }
    const headers = { host: 'localhost' }
    if (cookieHeader) headers.cookie = cookieHeader
    const req = https.request(
      { host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false, method: 'GET', path, headers },
      (res) => {
        let bytes = 0
        res.on('data', (c) => {
          bytes += c.length
          if (abortAfterBytes && bytes >= abortAfterBytes) {
            res.destroy()
            done('abandoned')
          }
        })
        res.on('end', () => done(res.statusCode))
      },
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      done('TIMEOUT')
    })
    req.on('error', (e) => done(`ERR ${e.code}`))
    req.end()
  })
}

function httpsRequest(port, path, cookieHeader) {
  const headers = { host: 'localhost' }
  if (cookieHeader) headers.cookie = cookieHeader
  const req = https.request(
    { host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false, method: 'GET', path, headers },
    (res) => {
      res.resume()
    },
  )
  return req
}

test('abandoning a streamed response tears down the upstream request', async () => {
  await withGateway({}, async ({ port, state }) => {
    const login = await loginFor(port)
    const r = await rawRequest(port, '/stream', { cookieHeader: login, abortAfterBytes: 4 })
    assert.equal(r.status, 'abandoned')
    // the upstream must observe the disconnect promptly, not keep streaming
    for (let i = 0; i < 40 && state.streamClosedAt === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(state.streamClosedAt, 'upstream request was not torn down after client abandonment')
  })
})

test('a silent upstream turns into a 502 after upstreamTimeoutMs', async () => {
  await withGateway({ upstreamTimeoutMs: 300 }, async ({ port }) => {
    const login = await loginFor(port)
    const r = await rawRequest(port, '/hang', { cookieHeader: login, timeoutMs: 5000 })
    assert.equal(r.status, 502)
    assert.ok(r.ms < 4000, `expected fast 502, took ${r.ms}ms`)
  })
})

/** Login through the gateway; returns the session Cookie header value. */
function loginFor(port) {
  return new Promise((resolve, reject) => {
    const body = 'username=admin&password=secret-pass'
    const req = https.request(
      {
        host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false,
        method: 'POST', path: '/login',
        headers: { host: 'localhost', 'content-type': 'application/x-www-form-urlencoded', 'content-length': body.length },
      },
      (res) => {
        res.resume()
        const c = (res.headers['set-cookie'] ?? []).map((x) => x.split(';')[0]).join('; ')
        resolve(c)
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}
