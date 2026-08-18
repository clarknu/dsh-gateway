# Post-publish smoke test: the exact flow a third party runs.
#   dsh plugin --profile <name> add dsh-gateway   (from the npm registry)
# then boot and curl the gateway. Run: node scripts/postpublish-smoke.mjs
import { execFileSync } from 'node:child_process'
import { writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PROFILE = 'gwt-smoke'
const DSH = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(DSH, 'profiles', PROFILE)

const run = (cmd, args, opts = {}) => {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts })
}

// 1) fresh profile with the plugin straight from the npm registry
rmSync(profileDir, { recursive: true, force: true })
run('dsh', ['plugin', '--profile', PROFILE, 'add', 'dsh-gateway'])

// 2) patch layer: loopback web surface on 3090 + gateway hosts
const patch = `- id: webserver
  config:
    host: '127.0.0.1'
    port: 3090

- id: gateway
  config:
    port: 3453
    sites:
      - hosts: ['localhost', '127.0.0.1']
`
writeFileSync(join(profileDir, 'cordis.patch.yml'), patch, 'utf8')

// 3) add the web surface from the local installation (npm's dsh-web-app is a
//    stale rc.1; the running installation resolves the in-box rc.6 instead)
const manifest = join(profileDir, 'package.json')
const pkg = JSON.parse(require('node:fs').readFileSync(manifest, 'utf8'))
pkg.dsh.profile.bundles.splice(1, 0, '@deepseek-ai/dsh-web-app')
writeFileSync(manifest, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

console.log('\nBoot with:  dsh --profile gwt-smoke --port 3090')
console.log('Probe with: curl -sk https://127.0.0.1:3453/login  (expect 200)')
