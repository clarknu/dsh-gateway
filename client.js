// Browser half of the dsh-gateway plugin: the Settings-page card. Contributes
// one card to the `settings.plugin.item` slot (same protocol as other
// third-party plugins). The card edits the same `gateway:` settings namespace
// the plugin owns, through the host's /gateway/panel route, so every change is
// validated, persisted, and hot-applied exactly like an external edit — with
// explicit per-operation feedback: saving shows "saving…", listener-affecting
// saves and restarts show "restarting…" and settle on "restarted" / a failure
// reason, by polling the panel's `phase` field until the listener comes back
// with a fresh `startedAt`.
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning cordis-plugin exports) — no build step, no bundled
// imports beyond react and the shipped UI primitives.

window.__ModuleLoader__.load({
  id: 'dsh-gateway',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var T = {
      title: 'Remote Gateway',
      running: '运行中',
      stopped: '已停用',
      errored: '运行异常',
      loading: '加载中…',
      upstream: '上游',
      listen: '监听',
      hosts: '主机白名单',
      sessionDays: '会话天数',
      version: '版本',
      enable: '启用',
      disable: '停用',
      enabling: '正在启用…',
      disabling: '正在停用…',
      enabledOk: '已启用',
      disabledOk: '已停用',
      restart: '重启网关',
      restarting: '正在重启…',
      restarted: '重启成功',
      restartFailed: '重启失败',
      listener: '监听配置',
      bindIp: '绑定 IP',
      bindIpHint: '127.0.0.1 = 仅本机；0.0.0.0 = 所有网卡（对外暴露）',
      portLabel: '对外端口',
      portHint: '1–65535；修改后监听自动重启',
      portInvalid: '端口需为 1–65535 的整数',
      saveListener: '保存监听配置',
      savingListener: '正在保存并重启监听…',
      listenerApplied: '保存成功，监听已重启并生效',
      accounts: '登录账号',
      username: '用户名',
      password: '密码',
      saveAccount: '保存账号',
      savingUser: '正在保存账号…',
      userSaved: '账号已保存，已生效',
      userEmpty: '请输入用户名',
      passEmpty: '请输入密码',
      deleteUser: '删除',
      removingUser: '正在删除账号…',
      userRemoved: '账号已删除，已生效',
      confirmDeleteUser: '确定删除账号',
      accountsEmpty: '（无账号，无人可登录）',
      passwordNote: '密码保存时会在服务端以 scrypt 哈希存储，不落明文',
      logs: '网关日志',
      noLogs: '（暂无日志）',
      unreachable: '网关面板不可用（宿主路由未注册）',
      settingsHint: '完整配置（证书、多站点等）在 settings.yaml 的 gateway: 段',
      failed: '操作失败',
      noChanges: '没有需要保存的改动',
      autoCert: '自动自签',
      certFile: '证书文件',
      disableConfirm: '停用后远程连接会立即断开（本页面也会不可达），只能在本机通过 settings.yaml 重新启用。确定停用？',
    }
    var E = {
      title: 'Remote Gateway',
      running: 'running',
      stopped: 'stopped',
      errored: 'error',
      loading: 'loading…',
      upstream: 'upstream',
      listen: 'listen',
      hosts: 'hosts',
      sessionDays: 'session days',
      version: 'version',
      enable: 'Enable',
      disable: 'Disable',
      enabling: 'Enabling…',
      disabling: 'Disabling…',
      enabledOk: 'Enabled',
      disabledOk: 'Disabled',
      restart: 'Restart gateway',
      restarting: 'Restarting…',
      restarted: 'Restarted',
      restartFailed: 'Restart failed',
      listener: 'Listener',
      bindIp: 'Bind IP',
      bindIpHint: '127.0.0.1 = this machine only; 0.0.0.0 = all interfaces (expose)',
      portLabel: 'Public port',
      portHint: '1–65535; the listener restarts on change',
      portInvalid: 'Port must be an integer between 1 and 65535',
      saveListener: 'Save listener',
      savingListener: 'Saving and restarting the listener…',
      listenerApplied: 'Saved; the listener restarted and is live',
      accounts: 'Accounts',
      username: 'Username',
      password: 'Password',
      saveAccount: 'Save account',
      savingUser: 'Saving account…',
      userSaved: 'Account saved and live',
      userEmpty: 'Enter a username',
      passEmpty: 'Enter a password',
      deleteUser: 'Remove',
      removingUser: 'Removing account…',
      userRemoved: 'Account removed and live',
      confirmDeleteUser: 'Remove account',
      accountsEmpty: '(no accounts — nobody can log in)',
      passwordNote: 'Passwords are stored as scrypt hashes server-side, never in plaintext',
      logs: 'Gateway logs',
      noLogs: '(no log lines yet)',
      unreachable: 'gateway panel unavailable (host route missing)',
      settingsHint: 'Full config (certs, sites) lives in the gateway: section of settings.yaml',
      failed: 'operation failed',
      noChanges: 'nothing to save',
      autoCert: 'auto self-signed',
      certFile: 'cert files',
      disableConfirm: 'Disabling cuts your remote connection immediately (this page becomes unreachable). You would re-enable locally via settings.yaml. Continue?',
    }
    var labels = /^zh/i.test(typeof navigator !== 'undefined' ? navigator.language : 'en') ? T : E

    function post(action, payload) {
      return fetch('/gateway/panel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload === undefined ? { action } : Object.assign({ action }, payload)),
      }).then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok) throw new Error(body.error || r.status)
          return body
        })
      })
    }

    function GatewayCard(react) {
      var h = react.createElement
      var t = labels

      var chevron = (open) =>
        h(
          'svg',
          { width: 16, height: 16, viewBox: '0 0 16 16', style: { color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', flex: 'none', transition: 'transform .16s', transform: open ? 'rotate(180deg)' : 'none' } },
          h('path', { d: 'M4 6l4 4 4-4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        )

      var btn = (primary, disabled) => ({
        padding: '6px 14px',
        borderRadius: 8,
        border: primary ? 'none' : '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))',
        background: primary ? '#3964fe' : 'transparent',
        color: primary ? '#fff' : 'var(--dsw-alias-label, inherit)',
        fontSize: 13,
        fontWeight: 600,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
      })

      var inputStyle = {
        boxSizing: 'border-box',
        height: 32,
        width: 150,
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))',
        borderRadius: 8,
        padding: '0 10px',
        fontSize: 13,
        background: 'var(--dsw-alias-bg, transparent)',
        color: 'var(--dsw-alias-label, inherit)',
      }

      return function Card() {
        var openState = react.useState(false)
        var statusState = react.useState(null)
        var noteState = react.useState('')
        var feedbackState = react.useState(null)
        var busyState = react.useState(null)
        var listenDraftState = react.useState('')
        var portDraftState = react.useState('')
        var userNameState = react.useState('')
        var passState = react.useState('')
        var open = openState[0]
        var status = statusState[0]
        var note = noteState[0]
        var feedback = feedbackState[0]
        var busy = busyState[0]

        var load = react.useCallback(function () {
          return fetch('/gateway/panel')
            .then(function (r) {
              return r.json().then(function (body) {
                if (!r.ok) throw new Error(body.error || r.status)
                return body
              })
            })
            .then(function (body) {
              statusState[1](body)
              noteState[1]('')
            })
            .catch(function (error) {
              noteState[1](String(error.message || error))
            })
        }, [])

        react.useEffect(
          function () {
            if (!open) return
            load()
            var id = setInterval(load, 3000)
            return function () { clearInterval(id) }
          },
          [open, load],
        )

        function setFeedback(kind, text) {
          feedbackState[1]({ kind: kind, text: text })
        }

        /** Poll the panel until a listener swap settles: running with a fresh
         * startedAt, or an error. Retries through fetch failures — when the
         * page is reached through the gateway, the swap cuts the connection. */
        function waitForRestart(beforeStartedAt, timeoutMs) {
          var deadline = Date.now() + (timeoutMs || 8000)
          return new Promise(function (resolve, reject) {
            function tick() {
              fetch('/gateway/panel')
                .then(function (r) { return r.json() })
                .then(function (body) {
                  if (body.phase === 'error') return reject(new Error(body.lastError || 'gateway failed to start'))
                  if (body.phase === 'running' && body.startedAt && body.startedAt !== beforeStartedAt) return resolve(body)
                  if (Date.now() > deadline) return reject(new Error('restart timed out — refresh the page'))
                  setTimeout(tick, 350)
                })
                .catch(function () {
                  if (Date.now() > deadline) return reject(new Error('restart timed out — refresh the page'))
                  setTimeout(tick, 350)
                })
            }
            tick()
          })
        }

        function restart() {
          var before = status && status.startedAt
          busyState[1]('restart')
          setFeedback('busy', t.restarting)
          post('restart')
            .then(function () { return waitForRestart(before) })
            .then(function () { setFeedback('ok', t.restarted) })
            .catch(function (error) { setFeedback('err', t.restartFailed + ': ' + String(error.message || error)) })
            .then(function () { busyState[1](null); return load() })
        }

        function toggle() {
          if (status.enabled && !window.confirm(t.disableConfirm)) return
          var target = !status.enabled
          busyState[1]('toggle')
          setFeedback('busy', target ? t.enabling : t.disabling)
          post('update', { patch: { enabled: target } })
            .then(function () { setFeedback('ok', target ? t.enabledOk : t.disabledOk) })
            .catch(function (error) { setFeedback('err', t.failed + ': ' + String(error.message || error)) })
            .then(function () { busyState[1](null); return load() })
        }

        function applyListener() {
          var patch = {}
          var listen = String(listenDraftState[0]).trim()
          if (listen && listen !== String(status.listenHost)) patch.listenHost = listen
          var portDraft = String(portDraftState[0]).trim()
          if (portDraft !== '' && Number(portDraft) !== Number(status.port)) {
            var p = Number(portDraft)
            if (!Number.isInteger(p) || p < 1 || p > 65535) {
              setFeedback('err', t.portInvalid)
              return
            }
            patch.port = p
          }
          if (Object.keys(patch).length === 0) {
            setFeedback('ok', t.noChanges)
            return
          }
          var before = status && status.startedAt
          busyState[1]('listener')
          setFeedback('busy', t.savingListener)
          post('update', { patch: patch })
            .then(function () { return waitForRestart(before) })
            .then(function () { setFeedback('ok', t.listenerApplied) })
            .catch(function (error) { setFeedback('err', t.failed + ': ' + String(error.message || error)) })
            .then(function () { busyState[1](null); return load() })
        }

        function saveUser() {
          var username = String(userNameState[0]).trim()
          var password = String(passState[0])
          if (!username) { setFeedback('err', t.userEmpty); return }
          if (!password) { setFeedback('err', t.passEmpty); return }
          busyState[1]('user')
          setFeedback('busy', t.savingUser)
          post('mutate', { ops: [{ op: 'set', path: ['users', username], value: password }] })
            .then(function () {
              setFeedback('ok', t.userSaved)
              userNameState[1]('')
              passState[1]('')
            })
            .catch(function (error) { setFeedback('err', t.failed + ': ' + String(error.message || error)) })
            .then(function () { busyState[1](null); return load() })
        }

        function removeUser(username) {
          if (!window.confirm(t.confirmDeleteUser + ' ' + username + '？')) return
          busyState[1]('remove')
          setFeedback('busy', t.removingUser)
          post('mutate', { ops: [{ op: 'unset', path: ['users', username] }] })
            .then(function () { setFeedback('ok', t.userRemoved) })
            .catch(function (error) { setFeedback('err', t.failed + ': ' + String(error.message || error)) })
            .then(function () { busyState[1](null); return load() })
        }

        var summary = ''
        if (status) {
          if (status.phase === 'restarting') summary = t.restarting
          else if (status.phase === 'disabled') summary = t.stopped
          else if (status.phase === 'error') summary = t.errored + ' \u00b7 ' + (status.lastError || '')
          else if (status.running) summary = t.running + ' \u00b7 :' + status.port + ' \u2192 ' + status.upstream
          else summary = t.stopped + (status.lastError ? ' \u00b7 ' + status.lastError : '')
        } else if (open) {
          summary = note || t.loading
        }

        var body = null
        if (open) {
          var rows = []
          var disabled = busy !== null
          if (status) {
            var siteText = (status.sites || []).map(function (s) {
              return (s.hosts || []).join(',') + ' (' + (s.cert === 'file' ? t.certFile : t.autoCert) + ')'
            }).join(' | ')

            // actions + feedback
            rows.push(
              h('div', { key: 'd0', style: { padding: '8px 0', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
                h('button', { style: btn(true, disabled), disabled: disabled, onClick: toggle }, status.enabled ? t.disable : t.enable),
                h('button', { style: btn(false, disabled), disabled: disabled, onClick: restart }, t.restart),
                busy
                  ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' } },
                    busy === 'restart' ? t.restarting : busy === 'toggle' ? (status.enabled ? t.disabling : t.enabling) : busy === 'listener' ? t.savingListener : busy === 'user' ? t.savingUser : t.removingUser)
                  : null,
              ),
            )
            if (feedback) {
              rows.push(
                h('div', {
                  key: 'd0b',
                  style: {
                    padding: '6px 10px',
                    margin: '4px 0',
                    borderRadius: 8,
                    fontSize: 12,
                    background: feedback.kind === 'err' ? 'rgba(213,73,65,0.12)' : feedback.kind === 'ok' ? 'rgba(34,160,107,0.12)' : 'rgba(226,185,60,0.14)',
                    color: feedback.kind === 'err' ? '#d54941' : feedback.kind === 'ok' ? '#1e8e5a' : '#9a7b1a',
                  },
                }, feedback.text),
              )
            }

            // listener config
            rows.push(
              h('div', { key: 'd1', style: { padding: '10px 0 2px' } },
                h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary, inherit)', paddingBottom: 6 } }, t.listener),
                h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
                  h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary, inherit)' } }, t.bindIp),
                  h('input', {
                    type: 'text',
                    spellCheck: false,
                    value: listenDraftState[0] === '' ? String(status.listenHost) : listenDraftState[0],
                    placeholder: String(status.listenHost),
                    onChange: function (event) { listenDraftState[1](event.target.value) },
                    style: inputStyle,
                  }),
                  h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary, inherit)' } }, t.portLabel),
                  h('input', {
                    type: 'number',
                    min: 1,
                    max: 65535,
                    value: portDraftState[0] === '' ? String(status.port) : portDraftState[0],
                    placeholder: String(status.port),
                    onChange: function (event) { portDraftState[1](event.target.value) },
                    style: Object.assign({}, inputStyle, { width: 110 }),
                  }),
                  h('button', { style: btn(false, disabled), disabled: disabled, onClick: applyListener }, t.saveListener),
                ),
                h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', padding: '4px 0 0' } }, t.bindIpHint + ' \u00b7 ' + t.portHint),
              ),
            )

            // accounts
            var userNames = Object.keys(status.users || {})
            rows.push(
              h('div', { key: 'd2', style: { padding: '10px 0 2px' } },
                h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary, inherit)', paddingBottom: 6 } }, t.accounts),
                h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
                  h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary, inherit)' } }, t.username),
                  h('input', {
                    type: 'text',
                    spellCheck: false,
                    autoComplete: 'off',
                    value: userNameState[0],
                    onChange: function (event) { userNameState[1](event.target.value) },
                    style: inputStyle,
                  }),
                  h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary, inherit)' } }, t.password),
                  h('input', {
                    type: 'password',
                    autoComplete: 'new-password',
                    value: passState[0],
                    onChange: function (event) { passState[1](event.target.value) },
                    style: inputStyle,
                  }),
                  h('button', { style: btn(false, disabled), disabled: disabled, onClick: saveUser }, t.saveAccount),
                ),
                userNames.length === 0
                  ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', padding: '4px 0' } }, t.accountsEmpty)
                  : h('div', { style: { padding: '6px 0', display: 'flex', flexDirection: 'column', gap: 4 } },
                    userNames.map(function (username, index) {
                      return h('div', { key: 'u' + index, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 } },
                        h('span', { style: { fontFamily: 'ui-monospace, Consolas, monospace' } }, username),
                        h('span', { style: { color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' } }, '\u2022\u2022\u2022\u2022'),
                        h('button', {
                          style: { border: 'none', background: 'none', color: '#d54941', fontSize: 12, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1, padding: 0 },
                          disabled: disabled,
                          onClick: function () { return removeUser(username) },
                        }, t.deleteUser),
                      )
                    }),
                  ),
                h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', padding: '4px 0' } }, t.passwordNote),
              ),
            )

            // info
            rows.push(
              h('div', { key: 'd3', style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 13, padding: '8px 0' } },
                h('span', { style: { color: 'var(--dsw-alias-label-secondary, inherit)' } }, t.upstream),
                h('span', null, status.upstream),
                h('span', { style: { color: 'var(--dsw-alias-label-secondary, inherit)' } }, t.hosts),
                h('span', null, siteText || '\u2014'),
                h('span', { style: { color: 'var(--dsw-alias-label-secondary, inherit)' } }, t.sessionDays),
                h('span', null, String(status.sessionDays)),
                h('span', { style: { color: 'var(--dsw-alias-label-secondary, inherit)' } }, t.version),
                h('span', null, status.version),
              ),
            )
          }
          var logLines = status && status.logs ? status.logs : []
          rows.push(
            h('div', { key: 'd4', style: { padding: '8px 0' } },
              h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary, inherit)', paddingBottom: 6 } }, t.logs),
              h('div', {
                style: {
                  maxHeight: 180, overflow: 'auto', borderRadius: 8, padding: '8px 10px',
                  background: 'var(--dsw-alias-bg-subtle, rgba(0,0,0,0.04))',
                  fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, lineHeight: 1.6,
                },
              },
                logLines.length === 0
                  ? h('div', { style: { color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' } }, t.noLogs)
                  : logLines.slice(-40).map(function (line, index) {
                    return h('div', { key: index, style: { color: line.level === 'warn' ? '#c75b39' : 'var(--dsw-alias-label, inherit)', whiteSpace: 'pre-wrap' } },
                      line.t.slice(11, 19) + '  ' + line.msg)
                  }),
              ),
            ),
          )
          rows.push(h('div', { key: 'd5', style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', paddingTop: 8 } }, t.settingsHint))
          body = rows
        }

        return h(
          'div',
          { style: { border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))', borderRadius: 12, background: 'var(--dsw-alias-bg, transparent)' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', cursor: 'pointer' }, onClick: function () { openState[1](!open) } },
            chevron(open),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontSize: 14, fontWeight: 600 } }, t.title),
              h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, summary),
            ),
            h('span', {
              style: {
                width: 8, height: 8, borderRadius: '50%', flex: 'none',
                background: status && status.phase === 'running' ? '#22a06b' : status && status.phase === 'restarting' ? '#e2b93c' : 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.6))',
              },
            }),
          ),
          open
            ? h('div', { style: { margin: '0 16px 4px', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))', paddingTop: 6, paddingBottom: 10 } }, body)
            : null,
        )
      }
    }

    function registerCard(ctx) {
      if (typeof ctx.inject !== 'function') return
      ctx.inject(['slots'], function (scope) {
        // The card lives and dies with its host route: probe it once.
        fetch('/gateway/panel')
          .then(function (response) {
            if (response.status === 404) return
            try {
              mountCard(scope)
            } catch (error) {
              console.error('[dsh-gateway] settings card skipped: ' + error)
            }
          })
          .catch(function () {})
      })
    }

    function mountCard(ctx) {
      var react = require('react')
      var Card = GatewayCard(react)
      ctx.slots.inject('settings.plugin.item', function* () {
        // id for list-kind slots (dsh rc.6), key for keyed-kind slots (rc.7):
        // settings.plugin.item changed declaration kind between versions, and a
        // keyed slot throws without options.key — passing both stays compatible.
        yield ctx.slots.register({ name: 'settings.plugin.item', id: 'gateway', key: 'gateway', order: 30 }, Card)
      })
    }

    function apply(ctx) {
      registerCard(ctx)
    }
    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
