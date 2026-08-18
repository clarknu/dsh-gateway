// Cookie-session authentication for the gateway: HMAC-signed tokens, a
// per-IP login-failure lockout, and the login page. Ported from the battle-
// tested Caddy forward_auth service this plugin replaces, with the /check hop
// folded inline: the gateway checks the cookie itself on every request.

import { createHash, createHmac, timingSafeEqual, randomBytes } from 'node:crypto'

const b64url = (buf) => Buffer.from(buf).toString('base64url')

/** Parse a base64url token part; null when malformed. */
function b64urlDecode(s) {
  try {
    return Buffer.from(s, 'base64url')
  } catch {
    return null
  }
}

const safeEqual = (a, b) => a.length === b.length && timingSafeEqual(a, b)

export const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest()

/**
 * One authentication realm. Reads users/sessionDays live from the resolved
 * options object so a config reload takes effect without restarting the TLS
 * listener.
 */
export function createAuth(options) {
  const hmacSecret = options.hmacSecret ?? randomBytes(32).toString('base64')
  const failBuckets = new Map()

  const sign = (payload) => createHmac('sha256', hmacSecret).update(payload).digest()

  function issueCookieHeader(username) {
    const cookieName = options.cookieName ?? 'dsh_gw_sid'
    const days = options.sessionDays ?? 30
    const payload = JSON.stringify({ u: username, exp: Date.now() + days * 86400000 })
    const token = `${b64url(Buffer.from(payload, 'utf8'))}.${b64url(sign(payload))}`
    return (
      `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${days * 86400}`
    )
  }

  const clearCookieHeader = () =>
    `${options.cookieName ?? 'dsh_gw_sid'}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`

  /** Verify a Cookie header; returns the username when valid. */
  function verify(cookieHeader) {
    const cookieName = options.cookieName ?? 'dsh_gw_sid'
    if (!cookieHeader) return null
    const m = cookieHeader
      .split(';')
      .map((p) => p.trim())
      .find((p) => p.startsWith(`${cookieName}=`))
    if (!m) return null
    const token = m.slice(cookieName.length + 1)
    const dot = token.indexOf('.')
    if (dot <= 0) return null
    const payload = b64urlDecode(token.slice(0, dot))
    const sig = b64urlDecode(token.slice(dot + 1))
    if (!payload || !sig) return null
    const payloadText = payload.toString('utf8')
    if (!safeEqual(sig, sign(payloadText))) return null
    let data
    try {
      data = JSON.parse(payloadText)
    } catch {
      return null
    }
    if (!(data.u in (options.users ?? {}))) return null
    if (typeof data.exp !== 'number' || data.exp <= Date.now()) return null
    return data.u
  }

  /** Whether this IP is currently locked out after repeated failures. */
  function locked(ip) {
    const b = failBuckets.get(ip)
    if (!b) return false
    if (b.until <= Date.now()) {
      failBuckets.delete(ip)
      return false
    }
    return b.fails >= (options.loginFailLimit ?? 5)
  }

  function recordFailure(ip) {
    const now = Date.now()
    const b = failBuckets.get(ip) ?? { fails: 0, until: 0 }
    b.fails += 1
    b.until = now + (options.lockoutSeconds ?? 60) * 1000
    failBuckets.set(ip, b)
    if (failBuckets.size > 4096) {
      for (const [key, value] of failBuckets) {
        if (value.until <= now) failBuckets.delete(key)
      }
    }
  }

  function clearFailures(ip) {
    failBuckets.delete(ip)
  }

  /** Constant-time password check against the user table. */
  function checkCredentials(username, password) {
    const expected = (options.users ?? {})[username]
    if (expected === undefined) return false
    return safeEqual(sha256(password), sha256(expected))
  }

  return {
    issueCookieHeader,
    clearCookieHeader,
    verify,
    locked,
    recordFailure,
    clearFailures,
    checkCredentials,
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/**
 * The login page. `error` is an already-safe message key: 'bad', 'locked'.
 * Language follows Accept-Language (zh wins when present).
 */
export function loginPage({ title, error, acceptLanguage }) {
  const zh = /zh/i.test(acceptLanguage ?? '')
  const t = zh
    ? {
        heading: title,
        sub: '请输入访问凭据',
        username: '用户名',
        password: '密码',
        submit: '登录',
        bad: '用户名或密码错误',
        locked: '尝试次数过多，请 60 秒后再试',
        footer: '由 dsh-gateway 插件保护',
      }
    : {
        heading: title,
        sub: 'Sign in to continue',
        username: 'Username',
        password: 'Password',
        submit: 'Sign in',
        bad: 'Invalid username or password',
        locked: 'Too many attempts — try again in 60 seconds',
        footer: 'Protected by the dsh-gateway plugin',
      }
  const err = error ? `<p class="err">${esc(t[error] ?? error)}</p>` : ''
  return `<!doctype html>
<html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.heading)}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
  .card{background:#fff;border:1px solid #e5e6eb;border-radius:16px;box-shadow:0 8px 24px #0f172a14;padding:32px 36px;width:min(92vw,340px)}
  h1{font-size:18px;margin:0 0 4px;color:#0f1115}
  p.sub{font-size:13px;color:#86909c;margin:0 0 20px}
  label{display:block;font-size:13px;color:#454d5f;margin:12px 0 6px}
  input{box-sizing:border-box;width:100%;height:38px;border:1px solid #d0d3da;border-radius:8px;padding:0 12px;font-size:14px;outline:none}
  input:focus{border-color:#3964fe;box-shadow:0 0 0 2px #3964fe26}
  button{margin-top:22px;width:100%;height:40px;background:#3964fe;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
  button:hover{background:#2f55e0}
  .err{color:#d54941;font-size:13px;margin:12px 0 0}
  .foot{margin-top:24px;font-size:12px;color:#c2c6cf;text-align:center}
</style></head><body><div class="card">
<h1>${esc(t.heading)}</h1><p class="sub">${esc(t.sub)}</p>
<form method="post" action="/login">
  <label for="u">${esc(t.username)}</label><input id="u" name="username" autocomplete="username" placeholder="${esc(t.username)}" required>
  <label for="p">${esc(t.password)}</label><input id="p" name="password" type="password" autocomplete="current-password" autofocus>
  ${err}
  <button type="submit">${esc(t.submit)}</button>
</form>
<p class="foot">${esc(t.footer)}</p>
</div></body></html>`
}
