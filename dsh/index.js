// dsh-gateway — the Cordis plugin half. Owns config resolution (row config +
// the `gateway:` settings namespace), the persistent HMAC secret, gateway
// lifecycle, and hot reload: every committed settings change rebuilds the
// listener, swapping in the new server only after it binds successfully so a
// bad edit never drops the gate that is already up.
//
// Also mounts the `/gateway/panel` route (status, logs, restart, config
// patches) consumed by the Settings-page card in ./client.js.

import z from '@deepseek-ai/schemastery'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { createGateway } from '../lib/gateway-core.js'
import { hashPassword, verifyPassword, SCRYPT_PREFIX } from '../lib/auth.js'

export const name = 'gateway'

export const Config = z.object({
  enabled: z.boolean().default(true),
  listenHost: z.string().default('127.0.0.1'),
  port: z.natural().min(1).max(65535).default(3443),
  upstream: z.string().default(''),
  cookieName: z.string().default('dsh_gw_sid'),
  sessionDays: z.natural().min(1).default(30),
  title: z.string().default('DeepSeek Harness'),
  loginFailLimit: z.natural().min(1).default(5),
  lockoutSeconds: z.natural().min(1).default(60),
  maxBodyBytes: z.natural().min(1024).default(16384),
  users: z.dict(z.string().role('secret')).default({}),
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

/**
 * Rotate the session signing secret. Every previously issued cookie then
 * fails signature verification immediately — the "revoke all sessions" /
 * "log everyone out" action. The new secret is persisted to state.json so
 * restarts keep the invalidation, and pushed into the live options object so
 * the running gateway takes it without a listener restart.
 */
function rotateHmacSecret(dataDir, currentOptions, setSecret, log) {
  const secret = randomBytes(32).toString('base64')
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ hmacSecret: secret }, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    throw new Error(`failed to persist rotated session secret — ${error.message ?? error}`)
  }
  setSecret(secret)
  if (currentOptions) currentOptions.hmacSecret = secret
  log('gateway: session signing secret rotated — all existing sessions invalidated')
}

/**
 * Fail-closed gate. The published default credential pair (admin/change-me)
 * ships in this repository in plain text, so it must never back a
 * non-loopback listener: an unconfigured install has to mean "nobody can log
 * in", not "everyone knows the password". Returns an error message when the
 * resolved config would expose the web surface behind that credential, or
 * null when the config is safe to apply.
 */
export function defaultCredsGuard(cfg) {
  const users = cfg?.users ?? {}
  const listenHost = String(cfg?.listenHost ?? '')
  const loopbackOnly = /^(127\.0\.0\.1|::1|localhost)$/i.test(listenHost)
  if (!loopbackOnly && users.admin !== undefined && verifyPassword('change-me', users.admin)) {
    return 'refusing to apply: the published default credential admin/change-me is in effect on a non-loopback listener — set gateway.users to real credentials before exposing the gateway (see README "安全基线")'
  }
  return null
}

export function apply(ctx, config = {}) {
  const dataDir = gatewayDataDir()
  let hmacSecret = loadHmacSecret(dataDir)

  // Ring buffer for the panel's log view (and plain console output), plus a
  // file mirror so the last lines survive a plugin re-apply or process crash.
  const logLines = []
  const logFilePath = join(dataDir, 'gateway.log')
  const persistLog = (line) => {
    try {
      writeFileSync(logFilePath, `${JSON.stringify(line)}\n`, { encoding: 'utf8', flag: 'a' })
      if (statSync(logFilePath).size > 512 * 1024) {
        const tail = readFileSync(logFilePath, 'utf8').split('\n').slice(-200).join('\n')
        writeFileSync(logFilePath, tail, { encoding: 'utf8' })
      }
    } catch {
      // logging must never throw
    }
  }
  const pushLog = (level, msg) => {
    const line = { t: new Date().toISOString(), level, msg: String(msg) }
    logLines.push(line)
    if (logLines.length > 200) logLines.shift()
    persistLog(line)
    ;(level === 'warn' ? console.error : console.log)(msg)
  }
  const log = (msg) => pushLog('info', msg)
  const warn = (msg) => pushLog('warn', msg)
  log(`gateway plugin v${version} starting (pid ${process.pid})`)

  let settingsScope = null
  let current = null
  let currentOptions = null
  let rebuildChain = Promise.resolve()
  let startedAt = null
  let lastError = ''
  let lastOnErrorAt = 0
  let restarting = false

  const resolvedConfig = () => (settingsScope ? settingsScope.get() : config)

  /**
   * Reject a settings write whose resolved outcome would trip the fail-closed
   * gate (published admin/change-me behind a non-loopback listener). Checking
   * at write time — not only at rebuild time — keeps the stored document and
   * the running listener from ever diverging, and hands the caller a real
   * error instead of a silently skipped hot reload.
   * @returns true when the write was refused (response already sent).
   */
  function rejectUnsafeWrite(res, patch, ops) {
    const cfg = resolvedConfig()
    const nextUsers = Object.assign({}, cfg.users ?? {})
    if (patch && typeof patch.users === 'object' && patch.users !== null) {
      for (const [username, value] of Object.entries(patch.users)) nextUsers[username] = value
    }
    if (Array.isArray(ops)) {
      for (const op of ops) {
        if (!op || !Array.isArray(op.path) || op.path.length !== 2 || op.path[0] !== 'users') continue
        if (op.op === 'set') nextUsers[op.path[1]] = op.value
        if (op.op === 'unset') delete nextUsers[op.path[1]]
      }
    }
    const nextListenHost = patch && typeof patch.listenHost === 'string' ? patch.listenHost : cfg.listenHost
    const error = defaultCredsGuard({ listenHost: nextListenHost, users: nextUsers })
    if (!error) return false
    res.writeHead(400)
    res.end(JSON.stringify({ ok: false, error }))
    return true
  }

  // ── self-heal ─────────────────────────────────────────────────────────────
  // The observed failure mode: a suspend/resume race (S0ix Modern Standby)
  // can corrupt the listening socket while the server object still thinks it
  // is running — no 'error' event, no log, panel still says running, and the
  // port even stays TCP-connectable (the kernel completes the handshake from
  // the accept backlog). A TCP probe cannot see this half-dead state. Every
  // 60s we do a real HTTPS probe (TLS handshake + HTTP response) through the
  // physical NIC path, and rebuild only after 3 consecutive failures so a
  // transient blip never restarts a healthy gate.
  let healthTimer = null
  let checking = false
  let healthFails = 0
  const HEALTH_FAIL_LIMIT = 3

  /** First physical-NIC IPv4 (skip loopback/virtual/APIPA) — probes the real NIC path. */
  const primaryIPv4 = () => {
    try {
      for (const [name, addrs] of Object.entries(networkInterfaces())) {
        if (/^(lo|Loopback)/i.test(name)) continue
        if (/vEthernet|virtual|hyper-v/i.test(name)) continue
        for (const a of addrs ?? []) {
          if (a.family !== 'IPv4' || a.internal) continue
          if (a.address.startsWith('169.254.')) continue
          return a.address
        }
      }
    } catch {
      // fall through to loopback
    }
    return null
  }

  /**
   * HTTPS-level liveness probe: any HTTP status (2xx/3xx/4xx) counts as alive;
   * only timeout / connection failure / hung TLS means dead. The Host header
   * carries the probed address so the allow-list answers normally.
   */
  const probeHttps = (host, port, timeoutMs = 4000) =>
    new Promise((resolve) => {
      let settled = false
      const done = (ok) => {
        if (settled) return
        settled = true
        req.destroy()
        resolve(ok)
      }
      const req = httpsRequest(
        { host, port, path: '/', method: 'GET', rejectUnauthorized: false, timeout: timeoutMs, headers: { Host: host } },
        (res) => {
          res.resume()
          done(true)
        },
      )
      req.on('timeout', () => done(false))
      req.on('error', () => done(false))
      req.end()
    })

  const startHealthCheck = () => {
    stopHealthCheck()
    healthTimer = setInterval(() => {
      void checkHealth()
    }, 60000)
    healthTimer.unref?.()
  }
  const stopHealthCheck = () => {
    if (healthTimer) {
      clearInterval(healthTimer)
      healthTimer = null
    }
  }
  const checkHealth = async () => {
    const gw = current
    if (!gw || typeof gw.port !== 'number' || checking) return
    checking = true
    try {
      const host =
        currentOptions?.listenHost === '0.0.0.0'
          ? (primaryIPv4() ?? '127.0.0.1')
          : (currentOptions?.listenHost ?? '127.0.0.1')
      const ok = await probeHttps(host, gw.port)
      if (current !== gw) return
      if (ok) {
        if (healthFails > 0) healthFails = 0
        return
      }
      healthFails += 1
      if (healthFails >= HEALTH_FAIL_LIMIT) {
        healthFails = 0
        warn(`gateway: HTTPS health check failed ${HEALTH_FAIL_LIMIT}x consecutively — listener not serving, restarting`)
        await queueRebuild(true)
      } else {
        warn(`gateway: HTTPS health check failed (${healthFails}/${HEALTH_FAIL_LIMIT}) — will retry`)
      }
    } finally {
      checking = false
    }
  }

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
          restarting = false
          stopHealthCheck()
          try {
            current?.stop()
          } catch (error) {
            warn(`gateway: error stopping listener — ${error.message ?? error}`)
          }
          current = null
          currentOptions = null
          startedAt = null
          return
        }
        // Fail-closed gate: refuse to (re)start a non-loopback listener while
        // the published default credential pair is in effect — a warning in a
        // log is not a gate. A running listener survives a hot edit that trips
        // the guard, but only with a loud warning.
        const guardError = defaultCredsGuard(cfg)
        if (guardError) {
          restarting = false
          if (current && !force) {
            warn(`gateway: ${guardError} — kept the running listener; fix gateway.users before the next restart`)
          } else {
            stopHealthCheck()
            try {
              current?.stop()
            } catch (error) {
              warn(`gateway: error stopping listener — ${error.message ?? error}`)
            }
            current = null
            currentOptions = null
            startedAt = null
            lastError = guardError
            warn(`gateway: ${guardError}`)
          }
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
          // Listener-level errors after a successful bind: log + self-heal,
          // throttled so a recurring OS-level failure cannot spin a rebuild loop.
          onError: (error) => {
            const now = Date.now()
            if (now - lastOnErrorAt < 30000) {
              warn('gateway: listener error recurring — suppressing auto-restart')
              return
            }
            lastOnErrorAt = now
            void queueRebuild(true)
          },
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
            restarting = false
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
        restarting = true
        stopHealthCheck()
        try {
          current?.stop()
        } catch (error) {
          warn(`gateway: error stopping previous listener — ${error.message ?? error}`)
        }
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
          restarting = false
          bootWarnings(cfg, port)
          startHealthCheck()
        } catch (error) {
          restarting = false
          stopHealthCheck()
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
    } else {
      if (users.admin !== undefined && verifyPassword('change-me', users.admin)) {
        warn('gateway: the published default credential admin/change-me is configured — set a real password (non-loopback listeners refuse to start with it)')
      }
      const plaintext = Object.entries(users).filter(([, v]) => typeof v === 'string' && !v.startsWith(SCRYPT_PREFIX))
      if (plaintext.length > 0) {
        warn(`gateway: ${plaintext.map(([u]) => u).join(', ')} password(s) stored as plaintext — regenerate with "node scripts/hash-password.mjs" (scrypt)`)
      }
    }
    const hosts = (cfg.sites ?? []).flatMap((s) => s.hosts ?? [])
    if (hosts.length === 0 || (hosts.length === 1 && hosts[0] === 'localhost')) {
      warn(`gateway: listening on port ${port} but no public hostname is configured — add gateway.sites[].hosts (e.g. your domain) before exposing it`)
    }
  }

  // ── Settings-page panel route (consumed by ./client.js) ──────────────────
  const panelStatus = () => {
    const cfg = resolvedConfig()
    const phase = cfg.enabled === false ? 'disabled' : restarting ? 'restarting' : current ? 'running' : lastError ? 'error' : 'stopped'
    return {
      version,
      enabled: cfg.enabled !== false,
      running: current !== null,
      phase,
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
                if (body.action === 'revokeSessions') {
                  // "Log everyone out": rotate the signing secret so every
                  // previously issued cookie fails verification immediately.
                  // Takes effect live — no listener restart, no downtime.
                  try {
                    rotateHmacSecret(dataDir, currentOptions, (s) => { hmacSecret = s }, log)
                    res.writeHead(200)
                    res.end(JSON.stringify({ ok: true, action: 'revokeSessions', ...panelStatus() }))
                  } catch (error) {
                    res.writeHead(400)
                    res.end(JSON.stringify({ ok: false, error: error.message ?? String(error) }))
                  }
                  return
                }
                if (body.action === 'update') {
                  if (!settingsScope) {
                    res.writeHead(400)
                    return res.end(JSON.stringify({ ok: false, error: 'settings unavailable — edit settings.yaml directly' }))
                  }
                  // Refuse writes that would land on the published credential
                  // with a non-loopback listener (fail-closed gate).
                  if (rejectUnsafeWrite(res, body.patch ?? {}, null)) return
                  // Persist + validate; the settings watch queues the rebuild
                  // (its listener swap waits 120ms, letting this reply flush).
                  await settingsScope.update(body.patch ?? {})
                  res.writeHead(200)
                  res.end(JSON.stringify({ ok: true, ...panelStatus() }))
                  return
                }
                if (body.action === 'mutate') {
                  // Path-addressed edits, the redacted-safe write path for
                  // secret fields (users): the caller never restates passwords
                  // it could not have seen. New plaintext passwords are hashed
                  // server-side before persisting; scrypt values pass through.
                  if (!settingsScope) {
                    res.writeHead(400)
                    return res.end(JSON.stringify({ ok: false, error: 'settings unavailable — edit settings.yaml directly' }))
                  }
                  let provider
                  try {
                    provider = ctx.get('settings')
                  } catch {
                    provider = null
                  }
                  if (!provider || typeof provider.mutate !== 'function') {
                    res.writeHead(400)
                    return res.end(JSON.stringify({ ok: false, error: 'settings provider unavailable — edit settings.yaml directly' }))
                  }
                  const ops = (Array.isArray(body.ops) ? body.ops : []).map((op) => {
                    if (
                      op &&
                      op.op === 'set' &&
                      Array.isArray(op.path) &&
                      op.path.length === 2 &&
                      op.path[0] === 'users' &&
                      typeof op.value === 'string' &&
                      !op.value.startsWith(SCRYPT_PREFIX)
                    ) {
                      return { ...op, value: hashPassword(op.value) }
                    }
                    return op
                  })
                  // Refuse the write when its outcome would trip the gate.
                  if (rejectUnsafeWrite(res, null, ops)) return
                  await provider.mutate('gateway', ops)
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
    stopHealthCheck()
    if (current) log('gateway: plugin disposed — stopping listener')
    try {
      current?.stop()
    } catch (error) {
      warn(`gateway: error stopping listener on dispose — ${error.message ?? error}`)
    }
    current = null
  })
}
