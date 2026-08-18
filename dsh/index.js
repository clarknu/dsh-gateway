// dsh-gateway — the Cordis plugin half. Owns config resolution (row config +
// the `gateway:` settings namespace), the persistent HMAC secret, gateway
// lifecycle, and hot reload: every committed settings change rebuilds the
// listener, swapping in the new server only after it binds successfully so a
// bad edit never drops the gate that is already up.

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

const log = (msg) => console.log(msg)
const warn = (msg) => console.error(msg)

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
      warn(`gateway: unreadable state file ${statePath} — regenerating`)
    }
  }
  const secret = randomBytes(32).toString('base64')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(statePath, JSON.stringify({ hmacSecret: secret }, null, 2), { encoding: 'utf8', mode: 0o600 })
  return secret
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) {
    log('gateway: disabled (gateway.enabled = false)')
    return
  }

  const dataDir = gatewayDataDir()
  const hmacSecret = loadHmacSecret(dataDir)
  let settingsScope = null
  let current = null
  let currentOptions = null
  let rebuildChain = Promise.resolve()

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

  const queueRebuild = () => {
    rebuildChain = rebuildChain
      .then(async () => {
        const cfg = resolvedConfig()
        if (cfg.enabled === false) {
          current?.stop()
          current = null
          currentOptions = null
          log('gateway: disabled')
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
        if (current) {
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
          const previous = current
          current = null
          currentOptions = null
          previous.stop()
          log('gateway: listener settings changed — restarting')
        }
        try {
          const next = createGateway(options)
          const port = await next.start()
          current = next
          currentOptions = options
          bootWarnings(cfg, port)
        } catch (error) {
          warn(`gateway: failed to apply configuration, gateway is down — ${error.message}`)
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
