# dsh-gateway

自包含的 DeepSeek Harness 远程访问网关插件：把「Caddy HTTPS + Cookie 登录」这一层直接做成 DSH 插件 —— 无需 caddy.exe，跨平台，装上即用。

Self-contained HTTPS remote-access gateway for the DeepSeek Harness web surface: the "Caddy HTTPS + cookie login" layer as a dsh plugin — no caddy binary, cross-platform.

- **TLS 终止**：SNI 多站点多证书；未提供证书的站点自动生成自签证书（持久化，指纹稳定），并覆盖 SAN；无 SNI 的 IP 直连（`https://192.168.x.x`）正常工作
- **Cookie 会话登录**：HMAC 签名、HttpOnly + Secure + SameSite=Lax、多用户、可配置会话时长；登录失败按 IP 限速锁定；登出清除浏览器 cookie
- **反向代理**：全量转发到 DSH web 服务（含 SSE 与 WebSocket upgrade），自动携带 X-Forwarded-For/Proto/Host
- **Host 白名单**：只应答配置的主机名（防 DNS rebinding 类探测），其余 421
- **热更新**：通过 `gateway:` settings 命名空间配置（settings.yaml / Web 设置页），改用户/密码/限速即时生效；改端口/证书/站点自动重启监听

## 安装

```sh
dsh plugin --profile web add dsh-gateway
```

重启 web 应用后，网关默认监听 `0.0.0.0:3443`（HTTPS），自签证书 + 默认账号 `admin / change-me`。

> 首次启动会打印警告：请立刻修改默认密码并配置你的主机名（见下）。

## 配置

所有配置走 `$DSH_HOME/settings.yaml` 的 `gateway:` 段（热更新），也可在 profile 的 `cordis.patch.yml` 里覆盖 `gateway` 行的 `config:`。

```yaml
gateway:
  enabled: true            # false = 完全停用监听
  listenHost: '0.0.0.0'    # 或 '127.0.0.1'（只允许本机/反代访问）
  port: 3443               # 对外 HTTPS 端口
  upstream: ''             # 留空 = 自动跟随 DSH web 服务端口（推荐）
  cookieName: dsh_gw_sid
  sessionDays: 30          # 会话有效期（天）
  title: 'DeepSeek Harness'  # 登录页标题
  loginFailLimit: 5        # 每 IP 连续失败次数上限
  lockoutSeconds: 60       # 超限锁定秒数
  users:                   # 登录账号（密码明文存于 settings.yaml）
    admin: 'change-me'
  sites:                   # 站点列表：Host 白名单 + SNI 证书
    - hosts: ['fnzh.clarknu.net', '192.168.5.5']
      cert: 'C:/Soft/caddy/certs/fullchain.crt'   # 留空 = 自动生成自签证书
      key: 'C:/Soft/caddy/certs/fnzh.clarknu.net.key'
```

- `sites[].hosts` 支持精确匹配与 `*.example.com` 通配；一个端口可同时服务多个站点（按 SNI 选证书，无 SNI 用第一个站点的证书）
- 公网域名请提供 CA 签发的 `cert`/`key` 路径；局域网 IP 可留空用自签（浏览器首次访问需手动信任）
- `upstream` 留空时插件从注入的 `webServer` 服务读取真实端口，改 `dsh web --port` 无需再动网关配置

## 设置页配置面板（Web UI）

安装后，DSH 设置页会出现一张 **Remote Gateway** 卡片（通过 `settings.plugin.item` 插槽注册），提供：

- **状态摘要**：运行中/已停用、对外端口、上游地址、启动时间
- **启用 / 停用**：停用前弹确认（停用会切断远程连接，需本机 settings.yaml 恢复）
- **端口修改**：输入新端口应用 → 校验 → 持久化 → 监听自动重启
- **重启网关**：一键重建监听（先响应、后换监听，点击不会报错）
- **实时日志**：最近 40 条（每 3 秒自动刷新，警告橙色标注）
- 复杂配置（账号、证书、多站点等）仍走 settings.yaml 的 `gateway:` 段

卡片的所有操作与手改 settings.yaml 完全等价：同样经 schema 校验、持久化、热生效。

## Windows 托盘启动器（可选）

`tools/dsh-tray/` 附带一个原生 .NET WinForms 托盘控制器，用于隐藏 DSH 命令行窗口并以菜单方式管理实例：

- 构建（需 .NET SDK 10+）：`dotnet publish tools/dsh-tray/app/dsh-tray.csproj -c Release -o tools/dsh-tray/app/out`
- 双击 `start-tray.cmd` 启动（无窗口，常驻通知区域，蓝色圆形 G 图标）
- 右键菜单：每个实例一组「打开页面 / 打开网关 / 启动 / 重启 / 停止」，端口探测实时显示运行状态
- 实例异常退出弹气泡通知并显示日志尾部；菜单内可勾选「开机自启」
- 配置：复制 `config.example.json` 为 `config.json` 放到 exe 同目录，按实例填写（name/profile/webUrl/gatewayUrl）

## 安全基线（部署前必读）

1. **改默认密码**：`gateway.users` 里不要保留 `admin/change-me`
2. **DSH 本体只绑回环**：在 web profile 的 `cordis.patch.yml` 里把 webserver 锁到 `127.0.0.1`，让所有远程访问都经过网关认证：
   ```yaml
   - id: webserver
     config:
       host: '127.0.0.1'
       port: 3080
   ```
3. **配好 hosts 白名单**：`sites[].hosts` 只列你实际使用的域名/IP
4. **会话是无状态的**（HMAC 签名 cookie）：`/logout` 清除浏览器端 cookie；令牌在到期前若泄露仍有效，改 `users` 可立即撤销对应用户
5. 路由器的端口转发把外部端口映射到本机 `gateway.port` 即可

## 从现有 Caddy 栈迁移

若你已有「Caddyfile + forward_auth」方案（如 `C:\Soft\caddy`），映射关系如下：

| Caddy 现状 | dsh-gateway 对应配置 |
| --- | --- |
| `tls C:/.../fullchain.crt .../key` | `sites[].cert` / `sites[].key` |
| `192.168.5.5 { tls internal }` | 该站点 `cert`/`key` 留空（自动自签） |
| 认证服务 127.0.0.1:9090 的 users/hmacSecret/sessionDays | `gateway.users`（hmacSecret 自动生成并存于 `$DSH_HOME/gateway/state.json`） |
| `forward_auth /check` | 内置（每个请求直接验 cookie） |
| `reverse_proxy 127.0.0.1:3080` | `upstream`（留空自动跟随） |
| 登录页 /login、/logout | 同路径，样式一致，中英自动切换 |

迁移步骤：`dsh plugin --profile web add dsh-gateway` → 按上表填 settings.yaml → 重启 web 应用 → 验证通过后停用 Caddy 计划任务（保留 Caddyfile 与证书作为回退）。

## 开发

```sh
npm install
npm test        # node:test 单元测试：认证/限速/代理/WS/SNI/无SNI/热更新
```

- `lib/` 是与 Cordis 无关的核心（认证、代理、证书、HTTPS 服务器），可独立使用与测试
- `dsh/index.js` 是插件封装（配置解析、settings 命名空间、生命周期、热重载）
- `scripts/` 是调试脚本（`ws-real-probe.mjs` 可对任意部署做真实 WS 探针）

## License

MIT
