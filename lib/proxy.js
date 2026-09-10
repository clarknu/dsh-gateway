// Minimal reverse proxy from the gateway's HTTPS listener to the loopback
// upstream (the dsh webserver): plain HTTP requests and WebSocket upgrades.
// Dependency-free on purpose — node:http request + node:net upgrade socket,
// streaming both ways so SSE and long responses are never buffered.

import http from 'node:http'
import net from 'node:net'

/** RFC 7230 hop-by-hop headers, never forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Create a proxy target from an http(s) upstream URL string. */
export function createProxy(upstream) {
  const target = new URL(upstream)
  if (target.protocol !== 'http:') {
    throw new Error(`gateway: upstream must be plain http (loopback), got ${target.protocol}`)
  }
  const host = target.hostname
  const port = Number(target.port || 80)
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 })
  /** Loopback authority we present upstream (rewrites the client's Host). */
  const upstreamAuthority = port === 80 ? host : `${host}:${port}`
  /** Origin header we present upstream, matching the rewritten Host. */
  const upstreamOrigin = `http://${upstreamAuthority}`

  const forwardHeaders = (req) => {
    const headers = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
      headers[name] = value
    }
    // Loopback-masquerade mode: rewrite Host and Origin to the upstream
    // loopback authority. The dsh trust fence accepts loopback hosts and
    // requires Origin.host === Host.host, so both must move together.
    headers.host = upstreamAuthority
    if (headers.origin !== undefined) {
      headers.origin = upstreamOrigin
    }
    const peer = req.socket.remoteAddress ?? ''
    const prior = req.headers['x-forwarded-for']
    headers['x-forwarded-for'] = prior ? `${prior}, ${peer}` : peer
    headers['x-forwarded-proto'] = 'https'
    headers['x-forwarded-host'] = req.headers.host ?? ''
    return headers
  }

  const stripHop = (headers) => {
    const out = {}
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
      out[name] = value
    }
    return out
  }

  /** Rewrite upstream absolute Location headers back to the public base. */
  const rewriteLocation = (headers, clientHost) => {
    const loc = headers.location
    if (typeof loc === 'string' && loc.startsWith(`http://${upstreamAuthority}`)) {
      headers.location = `https://${clientHost}${loc.slice(`http://${upstreamAuthority}`.length)}`
    }
    return headers
  }

  /** Browser-cookie compatibility for the web we proxy.
   *
   * The dsh web issues its browser-token session cookie as `SameSite=Strict`
   * and without `Secure`. Through a reverse proxy, after the gateway login,
   * browsers that classify the follow-up navigation as cross-site drop a
   * `Strict` cookie, so the client loops on the web's 401 "dsh web
   * authentication required" while other browsers succeed (observed: different
   * browsers, different results). Every client request here is over the
   * gateway's HTTPS listener and the web's loopback boundary is already gated by
   * the gateway's own auth, so rewriting the upstream cookies to `Secure` +
   * `SameSite=Lax` (the modern default) is safe and makes login browser-agnostic.
   * Mutates the headers object and returns it. */
  const compatCookies = (headers) => {
    const cookie = headers['set-cookie']
    if (cookie === undefined) return headers
    const rewrite = (value) => {
      let s = value
      s = s.replace(/;\s*SameSite=Strict\b/gi, '; SameSite=Lax')
      if (!/;\s*SameSite=/i.test(s)) s += '; SameSite=Lax'
      if (!/;\s*Secure\b/i.test(s)) s += '; Secure'
      return s
    }
    headers['set-cookie'] = Array.isArray(cookie) ? cookie.map(rewrite) : rewrite(cookie)
    return headers
  }

  /** Proxy one plain HTTP request.
   *
   * `hooks.relayUnauthorized(req, res)` may claim the response before any
   * header is written; it returns true when it has answered instead. */
  function handleRequest(req, res, hooks) {
    const upstreamReq = http.request(
      {
        host,
        port,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req),
        agent,
      },
      (upstreamRes) => {
        // 401 from the web = the browser holds no valid dsh session cookie.
        // Offer the gateway the chance to hand it the process-token handshake
        // URL instead of relaying the bare 401 (see gateway-core's
        // relayToWebToken). Checked before writeHead so the relay owns the
        // response outright; the upstream body is then discarded.
        if (
          (upstreamRes.statusCode ?? 502) === 401 &&
          typeof hooks?.relayUnauthorized === 'function' &&
          hooks.relayUnauthorized(req, res)
        ) {
          upstreamRes.resume()
          return
        }
        const outHeaders = stripHop(upstreamRes.headers)
        if (outHeaders.location !== undefined) rewriteLocation(outHeaders, req.headers.host ?? '')
        compatCookies(outHeaders)
        res.writeHead(upstreamRes.statusCode ?? 502, outHeaders)
        if (req.method === 'HEAD' || upstreamRes.statusCode === 204 || upstreamRes.statusCode === 304) {
          upstreamRes.resume()
          res.end()
        } else {
          upstreamRes.pipe(res)
        }
      },
    )
    upstreamReq.on('error', (err) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`gateway: upstream unreachable (${err.code ?? err.message})`)
    })
    req.on('error', () => upstreamReq.destroy())
    req.pipe(upstreamReq)
  }

  /** Proxy one WebSocket (or other protocol) upgrade. */
  function handleUpgrade(req, socket, head) {
    const upstreamSocket = net.connect(port, host, () => {
      // Keep Connection/Upgrade (they make this an upgrade request upstream)
      // while stripping the rest of the hop-by-hop set.
      const headers = {}
      for (const [name, value] of Object.entries(forwardHeaders(req))) {
        headers[name] = value
      }
      headers.connection = req.headers.connection ?? 'Upgrade'
      headers.upgrade = req.headers.upgrade ?? 'websocket'
      let line = `${req.method} ${req.url} HTTP/1.1\r\n`
      for (const [name, value] of Object.entries(headers)) {
        line += `${name}: ${value}\r\n`
      }
      line += '\r\n'
      upstreamSocket.write(line)
      if (head && head.length > 0) upstreamSocket.write(head)
      // Both directions are raw from here: the upstream's real handshake
      // response (e.g. 101 + Sec-WebSocket-Accept) flows through verbatim.
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
    })
    upstreamSocket.on('error', () => {
      if (!socket.destroyed) {
        socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      }
    })
    upstreamSocket.on('close', () => {
      if (!socket.destroyed) socket.destroy()
    })
    socket.on('error', () => upstreamSocket.destroy())
    socket.on('close', () => upstreamSocket.destroy())
    upstreamSocket.on('close', () => socket.destroy())
  }

  return {
    upstream,
    handleRequest,
    handleUpgrade,
    close() {
      agent.destroy()
    },
  }
}
