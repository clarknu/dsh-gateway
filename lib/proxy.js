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

  const forwardHeaders = (req) => {
    const headers = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
      headers[name] = value
    }
    headers.host = port === 80 ? host : `${host}:${port}`
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

  /** Proxy one plain HTTP request. */
  function handleRequest(req, res) {
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
        res.writeHead(upstreamRes.statusCode ?? 502, stripHop(upstreamRes.headers))
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
