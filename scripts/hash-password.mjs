#!/usr/bin/env node
// Generate a scrypt hash for the gateway `users` config.
//
//   node scripts/hash-password.mjs 'my-secret'      # from argv
//   node scripts/hash-password.mjs                  # reads the first line of stdin
//
// Put the printed value into settings.yaml under gateway.users:
//
//   gateway:
//     users:
//       admin: 'scrypt$16384$8$1$...'
//
// The gateway verifies scrypt values in constant time; plaintext values still
// work (legacy) but the plugin warns on boot until they are migrated.

import { hashPassword } from '../lib/auth.js'

function fail(message) {
  console.error(message)
  process.exit(1)
}

const fromArgv = process.argv[2]
if (fromArgv !== undefined) {
  if (!fromArgv) fail('usage: node scripts/hash-password.mjs <password>')
  console.log(hashPassword(fromArgv))
} else {
  let data = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) data += chunk
  const password = data.trim().split('\n')[0] ?? ''
  if (!password) fail('usage: node scripts/hash-password.mjs <password> (or pipe one line on stdin)')
  console.log(hashPassword(password))
}
