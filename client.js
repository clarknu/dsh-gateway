// Browser half of the dsh-gateway plugin: the Settings-page card. Contributes
// one card to the `settings.plugin.item` slot (same protocol as other
// third-party plugins) showing gateway status, recent logs, and quick
// actions: enable/disable, change port, restart. Full configuration stays in
// settings.yaml under `gateway:`; the card edits the same namespace through
// the host's /gateway/panel route, so every change is validated, persisted,
// and hot-applied exactly like an external edit.
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
      loading: '加载中…',
      upstream: '上游',
      listen: '监听',
      hosts: '主机白名单',
      sessionDays: '会话天数',
      version: '版本',
      enable: '启用',
      disable: '停用',
      restart: '重启网关',
      apply: '应用',
      portLabel: '对外端口',
      portHint: '1–65535，修改后自动重启监听',
      logs: '网关日志',
      noLogs: '（暂无日志）',
      unreachable: '网关面板不可用（宿主路由未注册）',
      settingsHint: '完整配置（账号、证书、多站点等）在 settings.yaml 的 gateway: 段',
      failed: '操作失败',
      autoCert: '自动自签',
      certFile: '证书文件',
      disableConfirm: '停用后远程连接会立即断开（本页面也会不可达），只能在本机通过 settings.yaml 重新启用。确定停用？',
    }
    var E = {
      title: 'Remote Gateway',
      running: 'running',
      stopped: 'stopped',
      loading: 'loading…',
      upstream: 'upstream',
      listen: 'listen',
      hosts: 'hosts',
      sessionDays: 'session days',
      version: 'version',
      enable: 'Enable',
      disable: 'Disable',
      restart: 'Restart gateway',
      apply: 'Apply',
      portLabel: 'Public port',
      portHint: '1–65535; the listener restarts on change',
      logs: 'Gateway logs',
      noLogs: '(no log lines yet)',
      unreachable: 'gateway panel unavailable (host route missing)',
      settingsHint: 'Full config (users, certs, sites) lives in the gateway: section of settings.yaml',
      failed: 'operation failed',
      autoCert: 'auto self-signed',
      certFile: 'cert files',
      disableConfirm: 'Disabling cuts your remote connection immediately (this page becomes unreachable). You would re-enable locally via settings.yaml. Continue?',
    }
    var labels = /^zh/i.test(typeof navigator !== 'undefined' ? navigator.language : 'en') ? T : E

    function post(action, patch) {
      return fetch('/gateway/panel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch === undefined ? { action } : { action, patch }),
      }).then((r) => r.json().then((body) => {
        if (!r.ok) throw new Error(body.error || r.status)
        return body
      }))
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

      var btn = (primary) => ({
        padding: '6px 14px',
        borderRadius: 8,
        border: primary ? 'none' : '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))',
        background: primary ? '#3964fe' : 'transparent',
        color: primary ? '#fff' : 'var(--dsw-alias-label, inherit)',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
      })

      return function Card() {
        var openState = react.useState(false)
        var statusState = react.useState(null)
        var noteState = react.useState('')
        var draftState = react.useState('')
        var open = openState[0]
        var status = statusState[0]
        var note = noteState[0]
        var draft = draftState[0]

        var load = react.useCallback(function () {
          return fetch('/gateway/panel')
            .then((r) => r.json().then((body) => {
              if (!r.ok) throw new Error(body.error || r.status)
              return body
            }))
            .then((body) => {
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

        var act = function (promise) {
          return promise
            .then(function () {
              // The listener may be mid-swap (a restart/port change tears the
              // connection down ~120ms after responding) — reload a beat later.
              return new Promise(function (resolve) { setTimeout(resolve, 450) }).then(load)
            })
            .catch(function (error) {
              noteState[1](t.failed + ': ' + String(error.message || error))
            })
        }

        var summary = ''
        if (status) {
          summary = status.running
            ? t.running + ' \u00b7 :' + status.port + ' \u2192 ' + status.upstream
            : status.enabled
              ? t.stopped + (status.lastError ? ' \u00b7 ' + status.lastError : '')
              : t.stopped
        } else if (open) {
          summary = note || t.loading
        }

        var body = null
        if (open) {
          var rows = []
          if (status) {
            var siteText = (status.sites || []).map(function (s) {
              return (s.hosts || []).join(',') + ' (' + (s.cert === 'file' ? t.certFile : t.autoCert) + ')'
            }).join(' | ')
            rows.push(
              h('div', { key: 'd0', style: { padding: '8px 0', display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h('button', { style: btn(true), onClick: function () {
                  if (status.enabled && !window.confirm(t.disableConfirm)) return
                  return act(post('update', { enabled: !status.enabled }))
                } },
                  status.enabled ? t.disable : t.enable),
                h('button', { style: btn(false), onClick: function () { return act(post('restart')) } }, t.restart),
              ),
              h('label', { key: 'd1', style: { display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0' } },
                h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary, inherit)' } }, t.portLabel),
                h('input', {
                  type: 'number',
                  min: 1,
                  max: 65535,
                  value: draft === '' ? String(status.port) : draft,
                  placeholder: String(status.port),
                  onChange: function (event) { draftState[1](event.target.value) },
                  style: {
                    boxSizing: 'border-box', height: 32, width: 110, border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.4))',
                    borderRadius: 8, padding: '0 10px', fontSize: 13, background: 'var(--dsw-alias-bg, transparent)',
                    color: 'var(--dsw-alias-label, inherit)',
                  },
                }),
                h('button', {
                  style: btn(false),
                  onClick: function () {
                    var port = Number(draft)
                    if (!Number.isInteger(port) || port < 1 || port > 65535) return
                    return act(post('update', { port }))
                  },
                }, t.apply),
              ),
              h('div', { key: 'd2', style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', padding: '2px 0' } }, t.portHint),
              h('div', { key: 'd3', style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 13, padding: '8px 0' } },
                h('span', { style: { color: 'var(--dsw-alias-label-secondary, inherit)' } }, t.listen),
                h('span', null, status.listenHost + ':' + status.port),
                h('span', { style: { color: 'var(--dsw-alias-label-secondary, inherit)' } }, t.upstream),
                h('span', null, status.upstream),
                h('span', { style: { color: 'var(--dsw-alias-label-secondary, inherit)' } }, t.hosts),
                h('span', null, siteText || '\u2014'),
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
                background: status && status.running ? '#22a06b' : 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.6))',
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
        yield ctx.slots.register({ name: 'settings.plugin.item', id: 'gateway', order: 30 }, Card)
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
