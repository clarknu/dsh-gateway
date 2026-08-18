# 实机迁移：Caddy 栈 → dsh-gateway（本机专用步骤）

> 目标机器：DSH_HOME=`C:\Users\Clark Nu\.dsh`，web profile 已运行于
> `127.0.0.1:3080`（已绑定回环）。当前 Caddy 栈：`C:\Soft\caddy`（双站点
> 53443 + 认证服务 9090 + 计划任务 `DSHCaddyProxy`）。
>
> 原则：**先并行、后退役**。插件网关用不同端口先跑，验证全部通过后再停 Caddy。

## 前置条件

- [ ] npm 已发布 `dsh-gateway`（`npm view dsh-gateway` 能看到版本）
- [ ] 已备份 settings.yaml：`copy "$env:USERPROFILE\.dsh\settings.yaml" "$env:USERPROFILE\.dsh\settings.yaml.bak"`

## 第 1 步：安装插件（不影响正在运行的会话）

```powershell
dsh plugin --profile web add dsh-gateway
```

安装本身不动运行中的进程；插件在下一次 web 应用重启时挂载。

## 第 2 步：写配置（先并行验证，端口 3443 不碰现有 53443）

向 `C:\Users\Clark Nu\.dsh\settings.yaml` 追加：

```yaml
gateway:
  enabled: true
  listenHost: '0.0.0.0'
  port: 3443                # 并行验证期；切换时改回 53443
  users:
    dsh: <现有 dsh 用户密码>
    clarknu: <现有 clarknu 用户密码>
  sites:
    - hosts: ['fnzh.clarknu.net']
      cert: 'C:/Soft/caddy/certs/fullchain.crt'
      key: 'C:/Soft/caddy/certs/fnzh.clarknu.net.key'
    - hosts: ['192.168.5.5']
      # cert/key 留空 = 自动生成自签证书（等同 Caddy 的 tls internal）
```

对应关系：Caddyfile 的 `tls ...fullchain.crt ...key` → `sites[0].cert/key`；
`192.168.5.5 { tls internal }` → `sites[1]` 留空；`auth-config.json` 的 users →
`gateway.users`（hmacSecret 自动生成于 `$DSH_HOME\gateway\state.json`，会话可跨重启）。

## 第 3 步：重启 web 应用并验证（重启会中断当前 GUI 会话，选好时机）

重启方式（按你们的运维习惯）：停掉再启动 `dsh web` 的服务/计划任务，或
`dsh --profile web` 重新拉起。然后逐项验证：

```powershell
# 1) 未登录 → 302 登录页（WAN 域名 + 正式证书）
curl.exe -s -o NUL -w "%{http_code} %{redirect_url}`n" https://fnzh.clarknu.net:3443/

# 2) 局域网 IP 直连（无 SNI，自签证书）
curl.exe -sk -o NUL -w "%{http_code} %{redirect_url}`n" https://192.168.5.5:3443/

# 3) 登录后拿到页面
curl.exe -sk -c $env:TEMP\c.txt -o NUL -w "%{http_code}`n" -d "username=dsh&password=<密码>" https://fnzh.clarknu.net:3443/login
curl.exe -sk -b $env:TEMP\c.txt -o NUL -w "%{http_code}`n" https://fnzh.clarknu.net:3443/

# 4) 未知 Host → 421
curl.exe -sk -o NUL -w "%{http_code}`n" -H "Host: evil.example.com" https://192.168.5.5:3443/
```

浏览器验证：完整登录 → 会话列表 → 发消息（WebSocket `/api/events.mux` 走网关）。

## 第 4 步：切换正式端口并退役 Caddy

验证稳定（建议观察 1–3 天）后：

1. settings.yaml 把 `gateway.port` 改成 `53443`（热更新，改完即生效）
2. 路由器端口转发目标不变（仍是本机 53443）
3. 确认 https://fnzh.clarknu.net:53443 与 https://192.168.5.5:53443 走插件网关
4. 停用 Caddy 栈（保留文件作回退，不删）：
   ```powershell
   schtasks /Change /TN "DSHCaddyProxy" /Disable   # 计划任务名以实际为准
   # 停止认证服务 node C:\Soft\caddy\auth-server.mjs 与 caddy.exe 进程
   ```
5. 回退预案：改回 `gateway.enabled: false`（或直接停插件监听），重新启用
   `DSHCaddyProxy` 计划任务即可恢复原状。

## 行为差异备忘

| 项目 | Caddy 现状 | dsh-gateway |
| --- | --- | --- |
| 认证端点 | 9090 独立服务（/check 供 forward_auth 调用） | 内置，直接验 cookie，无独立进程 |
| 会话 | HMAC cookie（auth-config.json 持久密钥） | 同机制，密钥在 `$DSH_HOME\gateway\state.json` |
| 证书 | WAN 正式证书 + LAN `tls internal` | 同（自签持久化于 `$DSH_HOME\gateway\certs\`） |
| 日志 | 认证服务独立输出 | dsh 进程输出 `gateway:` 前缀 |
| 改密码 | 编辑 auth-config.json + 重启认证服务 | 编辑 settings.yaml `gateway.users`，热生效 |
| 多站点 | Caddyfile 两个 site block | `gateway.sites` 列表（SNI 选证书） |

迁移完成后如需彻底清理：删除 `C:\Soft\caddy`（或至少停用计划任务），
`$DSH_HOME\profiles\web\cordis.patch.yml` 中 webserver 的回环绑定保持不变
（这是安全基线，不是 Caddy 专用）。
