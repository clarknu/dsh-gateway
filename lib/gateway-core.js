// The gateway server itself: one node:https listener that terminates TLS
// (SNI-selected per-site certificates, self-signed where none are supplied),
// enforces a Host allow-list, runs cookie-session login, and reverse-proxies
// everything else — WebSocket upgrades included — to the loopback upstream.
//
// Cordis-free by design: the plugin wrapper (../dsh/index.js) owns config
// resolution and lifecycle; this module is testable standalone.

import { createServer as createHttpsServer } from 'node:https'
import { createSecureContext } from 'node:tls'
import { X509Certificate } from 'node:crypto'
import { createAuth, loginPage } from './auth.js'
import { createProxy } from './proxy.js'
import { loadOrCreateSiteCert } from './certs.js'

/**
 * Create a gateway from resolved options. Returns `start()` (resolves the
 * actual bound port), `stop()`, and the proxy handle.
 *
 * options: {
 *   listenHost, port, upstream, cookieName, sessionDays, users, sites,
 *   certsDir, title, loginFailLimit, lockoutSeconds, maxBodyBytes, hmacSecret,
 *   log(msg), warn(msg)
 * }
 */
export function createGateway(options) {
  const log = options.log ?? (() => {})
  const warn = options.warn ?? log
  const proxy = createProxy(options.upstream, options)
  // Pass the options object itself: the plugin hot-reload mutates it in place
  // (Object.assign), and auth reads every field per request from this closure.
  const auth = createAuth(options)

  const sites = (options.sites ?? [{ hosts: ['localhost'] }]).map((site) => ({
    hosts: (site.hosts ?? []).map((h) => String(h).toLowerCase()),
    cert: site.cert ?? '',
    key: site.key ?? '',
  }))
  if (sites.length === 0) sites.push({ hosts: [], cert: '', key: '' })

  const allowList = new Set(sites.flatMap((s) => s.hosts))
  const allowAll = allowList.size === 0
  if (allowAll) {
    warn('gateway: no hosts configured — accepting every Host header (set gateway.sites[].hosts to restrict)')
  }

  const contexts = sites.map((site) => {
    const { cert, key } = loadOrCreateSiteCert(site, options.certsDir, log)
    return {
      hosts: site.hosts,
      context: createSecureContext({ cert, key }),
      certPem: cert,
      keyPem: key,
    }
  })
  const defaultSite = contexts[0]

  /** Host matching: exact, bare wildcard, or *.example.com wildcard. */
  function hostMatches(pattern, host) {
    if (pattern === host || pattern === '*') return true
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1)
      return host.endsWith(suffix) && host.length > suffix.length
    }
    return false
  }

  /** Strip port and brackets from a Host header value; lowercase. */
  function normalizeHost(header) {
    if (!header) return ''
    let host = String(header).trim().toLowerCase()
    if (host.startsWith('[')) {
      const end = host.indexOf(']')
      return end === -1 ? host : host.slice(1, end)
    }
    const colon = host.lastIndexOf(':')
    return colon === -1 ? host : host.slice(0, colon)
  }

  function selectContext(servername) {
    const name = (servername ?? '').toLowerCase()
    for (const entry of contexts) {
      if (entry.hosts.some((h) => hostMatches(h, name))) return entry.context
    }
    return defaultSite.context
  }

  function hostAllowed(host) {
    if (allowAll) return true
    for (const pattern of allowList) {
      if (hostMatches(pattern, host)) return true
    }
    return false
  }

  const send = (res, status, headers, body) => {
    res.writeHead(status, headers)
    res.end(body)
  }
  const redirect = (res, location) => send(res, 302, { Location: location, 'cache-control': 'no-store' }, '')

  function handleRequest(req, res) {
    const host = normalizeHost(req.headers.host)
    if (!hostAllowed(host)) {
      return send(res, 421, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, 'gateway: unknown host')
    }
    const url = new URL(req.url ?? '/', `https://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname
    const pageOpts = {
      title: options.title ?? 'DeepSeek Harness',
      acceptLanguage: req.headers['accept-language'],
    }

    if (path === '/login') {
      res.setHeader('x-content-type-options', 'nosniff')
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (auth.verify(req.headers.cookie)) return redirect(res, '/')
        return send(res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, loginPage(pageOpts))
      }
      if (req.method === 'POST') {
        const ip = req.socket.remoteAddress ?? '?'
        if (auth.locked(ip)) {
          return send(
            res,
            429,
            { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': String(options.lockoutSeconds ?? 60) },
            loginPage({ ...pageOpts, error: 'locked' }),
          )
        }
        let raw = ''
        req.on('data', (chunk) => {
          raw += chunk
          if (raw.length > (options.maxBodyBytes ?? 16384)) req.destroy()
        })
        return req.on('end', () => {
          let body = {}
          try {
            for (const [k, v] of new URLSearchParams(raw)) body[k] = v
          } catch {
            return send(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'bad request')
          }
          const username = String(body.username ?? '').trim()
          const password = String(body.password ?? '')
          if (!auth.checkCredentials(username, password)) {
            auth.recordFailure(ip)
            return send(res, 401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, loginPage({ ...pageOpts, error: 'bad' }))
          }
          auth.clearFailures(ip)
          return send(res, 302, { Location: '/', 'Set-Cookie': auth.issueCookieHeader(username), 'cache-control': 'no-store' }, '')
        })
      }
      return send(res, 405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD, POST' }, 'method not allowed')
    }

    if (path === '/logout') {
      return send(res, 302, { Location: '/login', 'Set-Cookie': auth.clearCookieHeader(), 'cache-control': 'no-store' }, '')
    }

    if (!auth.verify(req.headers.cookie)) {
      return redirect(res, '/login')
    }
    proxy.handleRequest(req, res)
  }

  function handleUpgrade(req, socket, head) {
    const host = normalizeHost(req.headers.host)
    if (!hostAllowed(host)) {
      socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n')
      return
    }
    if (!auth.verify(req.headers.cookie)) {
      socket.end('HTTP/1.1 302 Found\r\nLocation: /login\r\nConnection: close\r\n\r\n')
      return
    }
    proxy.handleUpgrade(req, socket, head)
  }

  let server = null
  let boundPort = null

  async function start() {
    // Pass the default site's cert/key directly: a server created with only a
    // SecureContext (no cert/key) sends handshake_failure to clients that omit
    // SNI — which is every browser connecting to an IP literal (https://192.168.x.x).
    // cert/key in the options keeps the no-SNI default context alive; the
    // SNICallback then selects per-host contexts for clients that do send SNI.
    server = createHttpsServer(
      {
        cert: defaultSite.certPem,
        key: defaultSite.keyPem,
        SNICallback: (servername, callback) => callback(null, selectContext(servername)),
      },
      handleRequest,
    )
    server.on('upgrade', handleUpgrade)
    server.on('tlsClientError', (_err, tlsSocket) => tlsSocket?.destroy())
    await new Promise((resolve, reject) => {
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      const onError = (err) => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      server.once('listening', onListening)
      server.once('error', onError)
      server.listen({ host: options.listenHost ?? '0.0.0.0', port: options.port ?? 3443 })
    })
    boundPort = server.address().port
    // Post-bind listener errors would otherwise be unhandled ('error' with no
    // listener throws and kills the whole process). Surface them and hand the
    // plugin a hook so it can self-heal instead of dying silently. Attached
    // only after the bind succeeds — the bind-phase error is handled by the
    // one-shot listener inside the start() promise.
    server.on('error', (err) => {
      warn(`gateway: listener error — ${err.code ?? err.message}`)
      if (server !== null) options.onError?.(err)
    })
    log(
      `gateway: https://${options.listenHost === '0.0.0.0' ? '0.0.0.0' : options.listenHost}:${boundPort} ` +
        `-> ${options.upstream} (hosts: ${allowAll ? '*' : [...allowList].join(',')})`,
    )
    return boundPort
  }

  function stop() {
    try {
      proxy.close()
    } catch {
      // agent teardown must never take the listener down with it
    }
    // Null the module-scoped reference BEFORE closing: a teardown 'error' on
    // the socket must not re-enter the onError self-heal hook.
    const old = server
    server = null
    boundPort = null
    if (old) {
      try {
        old.close()
      } catch {
        // already closed
      }
      old.closeAllConnections?.()
    }
  }

  return {
    start,
    stop,
    get port() {
      return boundPort
    },
    /** SHA-256 fingerprint of the certificate presented when no SNI name matches. */
    defaultCertFingerprint() {
      try {
        return new X509Certificate(defaultSite.certPem).fingerprint256
      } catch {
        return ''
      }
    },
  }
}
