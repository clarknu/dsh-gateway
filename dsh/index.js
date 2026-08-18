// dsh-gateway — the Cordis plugin half. Owns config resolution (row config +
// the `gateway:` settings namespace), the persistent HMAC secret, gateway
// lifecycle, and hot reload: every committed settings change rebuilds the
// listener, swapping in the new server only after it binds successfully so a
// bad edit never drops the gate that is already up.
//
// Also mounts the `/gateway/panel` route (status, logs, restart, config
// patches) consumed by the Settings-page card in ./client.js.

import z from '@deepseek-ai/schemastery'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createGateway } from '../lib/gateway-core.js'

export const name = 'gateway'

export const Config = z.object({
  enabled: z.boolean().default(true),
  listenHost: z.string().default('0.0.0.0'),
  port: z.natural().min(1).max(65535).default(3443),
  upstream: z.string().default(''),
  cookieName: z.string().default('dsh_gw_sid'),
  sessionDays: z.natural().min(1).default(30),
  title: z.string().default('DeepSeek Harness'),
  loginFailLimit: z.natural().min(1).default(5),
  lockoutSeconds: z.natural().min(1).default(60),
  maxBodyBytes: z.natural().min(1024).default(16384),
  users: z.dict(z.string().role('secret')).default({ admin: 'change-me' }),
  sites: z
    .array(
      z.object({
        hosts: z.array(z.string()).default([]),
        cert: z.string().default(''),
        key: z.string().default(''),
      }),
    )
    .default([{ hosts: ['localhost'], cert: '', key: '' }]),
})

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

/** $DSH_HOME/gateway — certs and the persistent signing secret live here. */
function gatewayDataDir() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'gateway')
}

/** Read-or-create the HMAC secret so sessions survive web-app restarts. */
function loadHmacSecret(dataDir) {
  const statePath = join(dataDir, 'state.json')
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      if (typeof state.hmacSecret === 'string' && state.hmacSecret.length >= 32) return state.hmacSecret
    } catch {
      console.error(`gateway: unreadable state file ${statePath} — regenerating`)
    }
  }
  const secret = randomBytes(32).toString('base64')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(statePath, JSON.stringify({ hmacSecret: secret }, null, 2), { encoding: 'utf8', mode: 0o600 })
  return secret
}

export function apply(ctx, config = {}) {
  const dataDir = gatewayDataDir()
  const hmacSecret = loadHmacSecret(dataDir)

  // Ring buffer for the panel's log view (and plain console output).
  const logLines = []
  const pushLog = (level, msg) => {
    const line = { t: new Date().toISOString(), level, msg: String(msg) }
    logLines.push(line)
    if (logLines.length > 200) logLines.shift()
    ;(level === 'warn' ? console.error : console.log)(msg)
  }
  const log = (msg) => pushLog('info', msg)
  const warn = (msg) => pushLog('warn', msg)

  let settingsScope = null
  let current = null
  let currentOptions = null
  let rebuildChain = Promise.resolve()
  let startedAt = null
  let lastError = ''

  const resolvedConfig = () => (settingsScope ? settingsScope.get() : config)

  /** The injected webServer service carries the real bound port. */
  const resolveUpstream = (cfg) => {
    if (cfg.upstream) return cfg.upstream
    try {
      const ws = ctx.webServer ?? ctx.get('webServer')
      if (ws && typeof ws.port === 'number') return `http://127.0.0.1:${ws.port}`
    } catch {
      // fall through
    }
    warn('gateway: webServer service unavailable — assuming upstream http://127.0.0.1:3080 (set gateway.upstream if different)')
    return 'http://127.0.0.1:3080'
  }

  const queueRebuild = (force = false) => {
    rebuildChain = rebuildChain
      .then(async () => {
        const cfg = resolvedConfig()
        if (cfg.enabled === false) {
          if (current) log('gateway: disabled — listener stopped')
          current?.stop()
          current = null
          currentOptions = null
          startedAt = null
          return
        }
        const options = {
          listenHost: cfg.listenHost,
          port: cfg.port,
          upstream: resolveUpstream(cfg),
          cookieName: cfg.cookieName,
          sessionDays: cfg.sessionDays,
          users: cfg.users ?? {},
          sites: cfg.sites ?? [{ hosts: ['localhost'] }],
          certsDir: join(dataDir, 'certs'),
          title: cfg.title,
          loginFailLimit: cfg.loginFailLimit,
          lockoutSeconds: cfg.lockoutSeconds,
          maxBodyBytes: cfg.maxBodyBytes,
          hmacSecret,
          log,
          warn,
        }
        if (current && !force) {
          // Two-tier hot reload: request-time fields mutate in place (no gap,
          // sessions survive); listener-affecting fields restart the server.
          const restartNeeded =
            currentOptions.listenHost !== options.listenHost ||
            currentOptions.port !== options.port ||
            currentOptions.upstream !== options.upstream ||
            JSON.stringify(currentOptions.sites) !== JSON.stringify(options.sites)
          if (!restartNeeded) {
            Object.assign(currentOptions, options)
            currentOptions.sites = options.sites
            return
          }
          log('gateway: listener settings changed — restarting')
        }
        // A listener swap tears down the very connection that requested it
        // (panel restart / port change). Give the in-flight response a beat
        // to flush before closing the old server.
        if (current) await new Promise((resolve) => setTimeout(resolve, 120))
        current?.stop()
        current = null
        currentOptions = null
        startedAt = null
        lastError = ''
        try {
          const next = createGateway(options)
          const port = await next.start()
          current = next
          currentOptions = options
          startedAt = new Date().toISOString()
          bootWarnings(cfg, port)
        } catch (error) {
          lastError = error.message ?? String(error)
          warn(`gateway: failed to apply configuration, gateway is down — ${lastError}`)
        }
      })
      .catch(() => {}) // a contained rebuild never poisons the chain
    return rebuildChain
  }

  function bootWarnings(cfg, port) {
    const users = cfg.users ?? {}
    if (Object.keys(users).length === 0) {
      warn('gateway: users is empty — nobody can log in (set gateway.users in settings.yaml)')
    } else if (Object.keys(users).length === 1 && users.admin === 'change-me') {
      warn('gateway: default credentials admin/change-me are in effect — change gateway.users NOW')
    }
    const hosts = (cfg.sites ?? []).flatMap((s) => s.hosts ?? [])
    if (hosts.length === 0 || (hosts.length === 1 && hosts[0] === 'localhost')) {
      warn(`gateway: listening on port ${port} but no public hostname is configured — add gateway.sites[].hosts (e.g. your domain) before exposing it`)
    }
  }

  // ── Settings-page panel route (consumed by ./client.js) ──────────────────
  const panelStatus = () => {
    const cfg = resolvedConfig()
    return {
      version,
      enabled: cfg.enabled !== false,
      running: current !== null,
      startedAt,
      lastError,
      listenHost: cfg.listenHost,
      port: current?.port ?? cfg.port,
      upstream: current ? currentOptions?.upstream : resolveUpstream(cfg),
      cookieName: cfg.cookieName,
      sessionDays: cfg.sessionDays,
      loginFailLimit: cfg.loginFailLimit,
      lockoutSeconds: cfg.lockoutSeconds,
      title: cfg.title,
      users: Object.fromEntries(Object.keys(cfg.users ?? {}).map((u) => [u, '\u2022\u2022\u2022\u2022'])),
      sites: (cfg.sites ?? []).map((s) => ({ hosts: s.hosts ?? [], cert: s.cert ? 'file' : 'auto' })),
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      const dispose = scope.webServer.register({
        kind: 'prefix',
        path: '/gateway/panel',
        handler: (req, res) => {
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          if (req.method === 'GET') {
            res.writeHead(200)
            res.end(JSON.stringify({ ...panelStatus(), logs: logLines.slice(-100) }))
            return
          }
          if (req.method === 'POST') {
            let raw = ''
            req.on('data', (chunk) => {
              raw += chunk
              if (raw.length > 65536) req.destroy()
            })
            return req.on('end', async () => {
              let body
              try {
                body = JSON.parse(raw || '{}')
              } catch {
                res.writeHead(400)
                return res.end(JSON.stringify({ ok: false, error: 'bad json' }))
              }
              try {
                if (body.action === 'restart') {
                  // Respond first: the rebuild tears down the listener that is
                  // serving this very request, so the reply must be out the
                  // door before the swap starts.
                  res.writeHead(200)
                  res.end(JSON.stringify({ ok: true, action: 'restart', ...panelStatus() }))
                  setTimeout(() => void queueRebuild(true), 50)
                  return
                }
                if (body.action === 'update') {
                  if (!settingsScope) {
                    res.writeHead(400)
                    return res.end(JSON.stringify({ ok: false, error: 'settings unavailable — edit settings.yaml directly' }))
                  }
                  // Persist + validate; the settings watch queues the rebuild
                  // (its listener swap waits 120ms, letting this reply flush).
                  await settingsScope.update(body.patch ?? {})
                  res.writeHead(200)
                  res.end(JSON.stringify({ ok: true, ...panelStatus() }))
                  return
                }
                res.writeHead(400)
                return res.end(JSON.stringify({ ok: false, error: `unknown action ${JSON.stringify(body.action)}` }))
              } catch (error) {
                res.writeHead(400)
                res.end(JSON.stringify({ ok: false, error: error.message ?? String(error) }))
              }
            })
          }
          res.writeHead(405, { allow: 'GET, POST' })
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        },
      })
      ctx.on('dispose', dispose)
    })
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (scope) => {
      try {
        const registration = scope.settings.register('gateway', Config, { base: config })
        settingsScope = registration
        registration.watch(() => {
          void queueRebuild()
        })
        void queueRebuild()
      } catch (error) {
        warn(`gateway: settings namespace unavailable, using the composition config only — ${error.message}`)
        void queueRebuild()
      }
    })
  }

  // Profiles without a settings service (or a webServer row that never
  // appears) still get the gateway from the composition config.
  void queueRebuild()

  ctx.on('dispose', () => {
    current?.stop()
    current = null
  })
}
