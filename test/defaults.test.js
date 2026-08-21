// Fail-closed defaults: an unconfigured install must mean "nobody can log in",
// not "everyone knows the password". These tests pin the schema defaults and
// the startup guard that refuses to back a non-loopback listener with the
// published credential pair (admin/change-me), whether it is stored in legacy
// plaintext or as a scrypt hash. Also covers the scrypt credential storage.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, defaultCredsGuard } from '../dsh/index.js'
import { createAuth, hashPassword, verifyPassword, SCRYPT_PREFIX } from '../lib/auth.js'

test('schema defaults are fail-closed: loopback listener, no accounts', () => {
  const cfg = Config()
  assert.equal(cfg.listenHost, '127.0.0.1')
  assert.deepEqual(cfg.users, {})
  assert.equal(cfg.port, 3443)
  assert.equal(cfg.enabled, true)
})

test('defaultCredsGuard: empty users are safe on any listener', () => {
  assert.equal(defaultCredsGuard({ listenHost: '0.0.0.0', users: {} }), null)
  assert.equal(defaultCredsGuard({ listenHost: '127.0.0.1', users: {} }), null)
})

test('defaultCredsGuard: refuses admin/change-me on a non-loopback listener (legacy plaintext)', () => {
  const reason = defaultCredsGuard({ listenHost: '0.0.0.0', users: { admin: 'change-me' } })
  assert.match(reason, /admin\/change-me/)
})

test('defaultCredsGuard: refuses admin/change-me on a non-loopback listener (scrypt hash)', () => {
  const reason = defaultCredsGuard({ listenHost: '0.0.0.0', users: { admin: hashPassword('change-me') } })
  assert.match(reason, /admin\/change-me/)
})

test('defaultCredsGuard: loopback-only with admin/change-me is an explicit local choice', () => {
  assert.equal(defaultCredsGuard({ listenHost: '127.0.0.1', users: { admin: 'change-me' } }), null)
  assert.equal(defaultCredsGuard({ listenHost: '127.0.0.1', users: { admin: hashPassword('change-me') } }), null)
  assert.equal(defaultCredsGuard({ listenHost: '::1', users: { admin: 'change-me' } }), null)
  assert.equal(defaultCredsGuard({ listenHost: 'localhost', users: { admin: 'change-me' } }), null)
})

test('defaultCredsGuard: real credentials on a non-loopback listener are fine', () => {
  assert.equal(defaultCredsGuard({ listenHost: '0.0.0.0', users: { admin: 's3cret!' } }), null)
  assert.equal(defaultCredsGuard({ listenHost: '0.0.0.0', users: { admin: hashPassword('s3cret!') } }), null)
})

test('hashPassword: produces a self-describing scrypt string', () => {
  const hash = hashPassword('hunter2')
  assert.ok(hash.startsWith(SCRYPT_PREFIX))
  assert.equal(hash.split('$').length, 6) // scrypt$N$r$p$salt$hash
})

test('verifyPassword: scrypt round-trip, wrong password, malformed values', () => {
  const hash = hashPassword('correct horse')
  assert.equal(verifyPassword('correct horse', hash), true)
  assert.equal(verifyPassword('wrong horse', hash), false)
  assert.equal(verifyPassword('', hash), false)
  assert.equal(verifyPassword('anything', SCRYPT_PREFIX + 'not-a-hash'), false)
  assert.equal(verifyPassword('anything', SCRYPT_PREFIX + '0$0$0$AA$AA'), false)
  assert.equal(verifyPassword('anything', ''), false)
  assert.equal(verifyPassword('anything', null), false)
})

test('verifyPassword: legacy plaintext still verifies (backward compatibility)', () => {
  assert.equal(verifyPassword('secret-pass', 'secret-pass'), true)
  assert.equal(verifyPassword('other-pass', 'secret-pass'), false)
})

test('rotating the signing secret invalidates every issued cookie (revoke-all-sessions)', () => {
  const options = {
    users: { admin: 'pw' },
    hmacSecret: 'secret-A-secret-A-secret-A-secret-A',
  }
  const auth = createAuth(options)
  const cookie = auth.issueCookieHeader('admin').split(';')[0]
  assert.equal(auth.verify(cookie), 'admin')
  // The plugin's revoke-sessions action mutates options.hmacSecret live.
  options.hmacSecret = 'secret-B-secret-B-secret-B-secret-B'
  assert.equal(auth.verify(cookie), null)
  // A newly issued cookie works under the rotated secret.
  const fresh = auth.issueCookieHeader('admin').split(';')[0]
  assert.equal(auth.verify(fresh), 'admin')
})
