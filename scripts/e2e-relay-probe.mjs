// End-to-end acceptance probe for the dsh process-token relay (T-010).
//
// Starts a SECOND, independent gateway instance (port 5443, its own temp certs)
// in front of the REAL dsh web upstream and drives the exact browser flow with
// curl.exe: gateway login → document navigation that the web answers with 401 →
// relay to /?token=<process token> → dsh cookie exchange → 200 index page.
//
// The real process token is per-process and only exists in the web process's
// stdout (the tray log); pass it in, never hard-code it:
//
//   $tok = (Select-String -Path "$env:USERPROFILE\.dsh\..\..\dsh-tray\bin\logs\web.out.log" `
//     -Pattern 'dsh web: http://127\.0\.0\.1:3080/\?token=([A-Za-z0-9_\-]+)').Matches[-1].Groups[1].Value
//   $env:DSH_PROBE_TOKEN = $tok
//   node scripts/e2e-relay-probe.mjs
//
// Touches only 127.0.0.1:5443. Never 3080 / 53443 / 3443.

import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { promisify } from 'node:util'
import { createGateway } from '../lib/gateway-core.js'
import { hashPassword } from '../lib/auth.js'

// Must be ASYNC: the gateway under test lives in this same process, so a
// synchronous child_process call would block the event loop that has to answer
// curl — a guaranteed timeout, not a code defect.
const execFileAsync = promisify(execFile)

const PORT = 5443
const UPSTREAM = 'http://127.0.0.1:3080'
const USER = 'probe'
const PASS = 'probe-pass-T010'
const BASE = `https://127.0.0.1:${PORT}`

const token = process.env.DSH_PROBE_TOKEN
if (!token) {
  console.error('FAIL: set DSH_PROBE_TOKEN (read it from the tray log; it changes with every web restart)')
  process.exit(2)
}

/** Redact the process token from anything we print. */
const redact = (s) => String(s).split(token).join(`<token:${token.length}chars>`)

const tmp = mkdtempSync(join(tmpdir(), 'dshgw-probe-'))
const jar = join(tmp, 'jar.txt')
const logs = []
let step = 0
const evidence = []
const fail = (msg) => {
  console.error(`\nFAIL @step ${step}: ${msg}`)
  console.error(evidence.join('\n'))
  process.exitCode = 1
  throw new Error(msg)
}

/**
 * One curl.exe call. The status code comes from -w on stdout; headers and body
 * go to files so nothing depends on shell quoting or piped stdio.
 * @returns {{code:number, headers:string, bodySize:number, headersOf:(n:string)=>string|null, setCookies:string[]}}
 */
async function curl(label, args) {
  step += 1
  const hdrFile = join(tmp, `h${step}.txt`)
  const bodyFile = join(tmp, `b${step}.bin`)
  const { stdout } = await execFileAsync(
    'curl.exe',
    ['-k', '-s', '-S', '--max-time', '30', '--retry', '2', '--retry-all-errors', '-D', hdrFile, '-o', bodyFile, '-w', '%{http_code}', ...args],
    { encoding: 'utf8', maxBuffer: 1 << 20 },
  )
  const code = stdout.trim()
  const headers = readFileSync(hdrFile, 'utf8')
  const lines = headers.split(/\r?\n/)
  const headersOf = (name) => {
    const hit = lines.find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))
    return hit ? hit.slice(hit.indexOf(':') + 1).trim() : null
  }
  const setCookies = lines.filter((l) => /^set-cookie:/i.test(l)).map((l) => l.slice(l.indexOf(':') + 1).trim())
  const bodySize = statSync(bodyFile).size
  const row = {
    label,
    code: Number(code),
    location: headersOf('location'),
    contentType: headersOf('content-type'),
    setCookies,
    bodySize,
  }
  evidence.push(
    `  ${label}: HTTP ${row.code}` +
      (row.location ? ` | Location: ${redact(row.location)}` : '') +
      (row.contentType ? ` | content-type: ${row.contentType}` : '') +
      (row.setCookies.length ? ` | Set-Cookie: ${row.setCookies.map(redact).join(' || ')}` : '') +
      ` | body ${row.bodySize} B`,
  )
  return { ...row, headersOf, bodyFile, headers }
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = createConnection({ host: '127.0.0.1', port })
    probe.on('connect', () => {
      probe.destroy()
      resolve(false)
    })
    probe.on('error', () => resolve(true))
    setTimeout(() => {
      probe.destroy()
      resolve(true)
    }, 1500)
  })
}

if (!(await portFree(PORT))) fail(`port ${PORT} is already in use — refusing to start`)

const certsDir = join(tmp, 'certs')
const gateway = createGateway({
  listenHost: '127.0.0.1',
  port: PORT,
  upstream: UPSTREAM,
  users: { [USER]: hashPassword(PASS) },
  sites: [{ hosts: ['127.0.0.1', 'localhost'] }],
  certsDir,
  hmacSecret: 'probe-secret-probe-secret-probe-secret-32',
  resolveWebToken: () => process.env.DSH_PROBE_TOKEN,
  log: (m) => logs.push(m),
  warn: (m) => logs.push(m),
})

try {
  const bound = await gateway.start()
  console.log(`probe gateway listening on 127.0.0.1:${bound} -> ${UPSTREAM}`)
  console.log(`token source: DSH_PROBE_TOKEN (${token.length} chars, redacted below)\n`)

  // 1. Log in to the gateway.
  const login = await curl('1 gateway login', [
    '-c', jar, '-b', jar,
    '-X', 'POST', '-d', `username=${USER}&password=${encodeURIComponent(PASS)}`,
    `${BASE}/login`,
  ])
  if (login.code !== 302) fail(`gateway login expected 302, got ${login.code}`)
  if (!login.setCookies.some((c) => c.startsWith('dsh_gw_sid='))) fail('gateway login issued no dsh_gw_sid cookie')

  // 2. A browser navigation with no dsh-auth cookie: the web answers 401 and
  //    the gateway must relay to the process token.
  const nav = await curl('2 GET / (no dsh-auth)', [
    '-c', jar, '-b', jar,
    '-H', 'Sec-Fetch-Mode: navigate', '-H', 'Accept: text/html,application/xhtml+xml',
    `${BASE}/`,
  ])
  if (nav.code !== 302) fail(`expected the relay 302, got ${nav.code} (upstream Location: ${redact(nav.location ?? 'none')})`)
  if (nav.location !== `/?token=${token}`) fail(`relay Location mismatch: ${redact(nav.location ?? 'none')}`)
  if (!nav.setCookies.some((c) => c.startsWith('dsh_gw_relay='))) fail('relay did not set the dsh_gw_relay marker cookie')
  const marker = nav.setCookies.find((c) => c.startsWith('dsh_gw_relay='))
  for (const attr of ['Max-Age=60', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure']) {
    if (!marker.includes(attr)) fail(`marker cookie missing ${attr}`)
  }

  // 3. Follow the relay: the real dsh web mints dsh-auth-* (303 → /).
  const exchange = await curl('3 GET /?token=… (follow)', [
    '-c', jar, '-b', jar,
    '-H', 'Sec-Fetch-Mode: navigate', '-H', 'Accept: text/html,application/xhtml+xml',
    `${BASE}${nav.location}`,
  ])
  if (exchange.code !== 303) fail(`expected the dsh token exchange 303, got ${exchange.code}`)
  const auth = exchange.setCookies.find((c) => c.startsWith('dsh-auth-'))
  if (!auth) fail('token exchange issued no dsh-auth-* cookie')
  if (/SameSite=Strict/i.test(auth)) fail('dsh-auth cookie still SameSite=Strict (T-009 compat not applied)')
  if (!/SameSite=Lax/i.test(auth)) fail('dsh-auth cookie missing SameSite=Lax')
  if (!/;\s*Secure\b/i.test(auth)) fail('dsh-auth cookie missing Secure')

  // 4. With both cookies the document loads.
  const page = await curl('4 GET / (with dsh-auth)', [
    '-c', jar, '-b', jar,
    '-H', 'Sec-Fetch-Mode: navigate', '-H', 'Accept: text/html,application/xhtml+xml',
    `${BASE}/`,
  ])
  if (page.code !== 200) fail(`expected 200 with the dsh cookie, got ${page.code}`)
  if (!/text\/html/.test(page.contentType ?? '')) fail(`expected text/html, got ${page.contentType}`)
  if (page.bodySize < 20000 || page.bodySize > 40000) fail(`index page size out of the expected 2-3万 range: ${page.bodySize} B`)

  // The relayed-once diagnostic must have been emitted exactly once.
  const relayLogs = logs.filter((m) => /relayed the dsh process token/.test(m))
  if (relayLogs.length !== 1) fail(`expected exactly 1 "relayed the dsh process token" log line, got ${relayLogs.length}`)
  const unavailable = logs.filter((m) => /process token not resolved/.test(m))
  if (unavailable.length !== 0) fail(`unexpected "process token not resolved" warning: ${unavailable[0]}`)

  console.log('step-by-step evidence:')
  console.log(evidence.join('\n'))
  console.log(`\ngateway log: 1x "relayed the dsh process token for the browser session handshake", 0x "process token not resolved"`)
  console.log('\nPASS: login → relay → dsh token exchange → 200 html, all through the gateway')
} catch (error) {
  if (process.exitCode !== 1) {
    console.error(`ERROR: ${error?.message ?? error}`)
    process.exitCode = 1
  }
} finally {
  gateway.stop()
  // Wait for the listener to actually release the port, then report.
  let free = false
  for (let i = 0; i < 20 && !free; i++) {
    await new Promise((r) => setTimeout(r, 150))
    free = await portFree(PORT)
  }
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    // temp cleanup is best-effort
  }
  console.log(`cleanup: listener stopped, temp certs removed, port ${PORT} ${free ? 'FREE' : 'STILL BOUND (!!)'}`)
  if (!free) process.exitCode = 1
}
