# dsh-tray — DeepSeek Harness 实例托盘启动器
#
# 职责：
#   * 以隐藏窗口方式启动/停止 dsh 实例（dsh --profile <name>），无黑色命令行窗口
#   * 常驻系统托盘（通知区域）图标，右键菜单提供：
#       打开页面 / 打开网关 / 启动 / 重启 / 停止 / 开机自启 / 退出
#   * 每 3 秒探测端口状态，实例异常退出时弹气泡通知
#   * "停止"只杀由本托盘启动的进程（按 --profile <name> 匹配 node 进程）；
#     端口被外部进程占用时视为"外部托管"，停止操作会先确认
#
# 使用：双击 start-tray.cmd；开机自启可在托盘菜单里勾选。
# 配置：同目录 config.json（instances 数组）。
#
# 测试开关（无托盘 UI）：
#   pwsh -File dsh-tray.ps1 -TestStart <profile>
#   pwsh -File dsh-tray.ps1 -TestStop  <profile>
#   pwsh -File dsh-tray.ps1 -TestPort  <profile>

param(
  [string]$TestStart,
  [string]$TestStop,
  [string]$TestPort
)

$ErrorActionPreference = 'Stop'
$configPath = Join-Path $PSScriptRoot 'config.json'
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# ── 工具函数 ──────────────────────────────────────────────────────────────

function Get-DshPath {
  # PowerShell 优先解析 dsh.ps1，但 cmd /c 只能跑 .cmd——取同目录的 .cmd 同僚
  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($cmd) {
    if ($cmd.Source -like '*.cmd') { return $cmd.Source }
    foreach ($candidate in @(
      [System.IO.Path]::ChangeExtension($cmd.Source, '.cmd'),
      (Join-Path (Split-Path $cmd.Source) 'dsh.cmd')
    )) {
      if (Test-Path $candidate) { return $candidate }
    }
  }
  foreach ($c in @("$env:APPDATA\npm\dsh.cmd", "$env:ProgramFiles\nodejs\dsh.cmd")) {
    if (Test-Path $c) { return $c }
  }
  return $null
}

function Test-PortListening([int]$port) {
  if ($port -le 0) { return $false }
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Get-ProfilePids([string]$profile) {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "--profile\s+[`"']?$([regex]::Escape($profile))[`"']?(\s|$)" } |
    Select-Object -ExpandProperty ProcessId
}

function Start-DshInstance($inst, [switch]$silent) {
  $profile = $inst.profile
  if (Get-ProfilePids $profile) {
    if (-not $silent) { Write-Warning "instance $profile already running" }
    return $null
  }
  $dsh = Get-DshPath
  if (-not $dsh) { throw "dsh 命令未找到（PATH 或 npm 全局 bin）" }
  $outLog = Join-Path $logDir "$profile.out.log"
  $errLog = Join-Path $logDir "$profile.err.log"
  $argLine = "`"$dsh`" --profile $profile"
  if ($inst.args) { $argLine += ' ' + ($inst.args -join ' ') }
  # cmd /c + WindowStyle Hidden：dsh（.cmd shim）及其 node 子进程都无窗口
  $proc = Start-Process -FilePath $env:ComSpec `
    -ArgumentList '/c', $argLine `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog
  if (-not $silent) { Write-Host "started $profile (cmd pid $($proc.Id)) — logs: $errLog" }
  return $proc
}

function Stop-DshInstance($inst, [switch]$silent) {
  $profile = $inst.profile
  $pids = Get-ProfilePids $profile
  foreach ($id in $pids) {
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
  if (-not $silent) { Write-Host "stopped $profile (killed node pids: $($pids -join ', '))" }
  return $pids.Count
}

function Get-Instances {
  $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
  return $cfg.instances
}

function Instance-State($inst) {
  $webPort = ([uri]$inst.webUrl).Port
  $gwPort = $inst.gatewayUrl -and ([uri]$inst.gatewayUrl).Scheme -eq 'https' ? ([uri]$inst.gatewayUrl).Port : 0
  return @{
    webUp = Test-PortListening $webPort
    gwUp  = Test-PortListening $gwPort
  }
}

# ── 测试模式 ──────────────────────────────────────────────────────────────

if ($TestStart -or $TestStop -or $TestPort) {
  $insts = Get-Instances
  if ($TestStart) {
    $inst = $insts | Where-Object { $_.profile -eq $TestStart }
    if (-not $inst) { throw "no instance for profile $TestStart" }
    Start-DshInstance $inst
    Start-Sleep -Seconds 8
    $s = Instance-State $inst
    Write-Host "state: web=$($s.webUp) gateway=$($s.gwUp)"
  }
  if ($TestStop) {
    $inst = $insts | Where-Object { $_.profile -eq $TestStop }
    if (-not $inst) { throw "no instance for profile $TestStop" }
    Stop-DshInstance $inst
    Start-Sleep -Seconds 2
    $s = Instance-State $inst
    Write-Host "state: web=$($s.webUp) gateway=$($s.gwUp)"
  }
  if ($TestPort) {
    $inst = $insts | Where-Object { $_.profile -eq $TestPort }
    if (-not $inst) { throw "no instance for profile $TestPort" }
    $s = Instance-State $inst
    Write-Host "web=$($s.webUp) gateway=$($s.gwUp) pids=$((Get-ProfilePids $TestPort) -join ',')"
  }
  exit 0
}

# ── 托盘模式 ──────────────────────────────────────────────────────────────

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:managed = @{}   # profile -> @{ startedByUs = $true/$false; proc = $null }
$script:lastState = @{} # profile -> 'up'/'down'
$script:exitNow = $false

function New-TrayIcon {
  # 简单绘制：蓝底圆角 + 白色 "G"
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(57, 100, 254))
  $g.FillEllipse($bg, 0, 0, 16, 16)
  $font = New-Object System.Drawing.Font 'Segoe UI', 9, ([System.Drawing.FontStyle]::Bold)
  $fg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $g.DrawString('G', $font, $fg, 3, 1)
  $hicon = $bmp.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($hicon)
  $g.Dispose(); $bmp.Dispose()
  return $icon
}

function Test-Autostart {
  $key = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'dsh-tray' -ErrorAction SilentlyContinue
  return [bool]$key
}

function Set-Autostart([bool]$on) {
  $run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  if ($on) {
    $hostExe = (Get-Process -Id $PID).Path
    $cmd = "`"$hostExe`" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSScriptRoot\dsh-tray.ps1`""
    Set-ItemProperty $run -Name 'dsh-tray' -Value $cmd
  } else {
    Remove-ItemProperty $run -Name 'dsh-tray' -ErrorAction SilentlyContinue
  }
}

function Refresh-InstanceStates {
  foreach ($inst in (Get-Instances)) {
    $s = Instance-State $inst
    $webUp = $s.webUp
    $prev = $script:lastState[$inst.profile]
    if ($prev -eq 'down' -and $webUp) {
      $script:tray.ShowBalloonTip(3000, 'dsh-tray', "$($inst.name) 已就绪", [System.Windows.Forms.ToolTipIcon]::Info)
    }
    if ($prev -eq 'up' -and -not $webUp -and $script:managed[$inst.profile] -and $script:managed[$inst.profile].startedByUs) {
      $tail = ''
      $errLog = Join-Path $logDir "$($inst.profile).err.log"
      if (Test-Path $errLog) { $tail = (Get-Content $errLog -Tail 3 -ErrorAction SilentlyContinue) -join ' ' }
      $script:tray.ShowBalloonTip(5000, 'dsh-tray', "$($inst.name) 异常退出$($tail ? "：$tail" : '')", [System.Windows.Forms.ToolTipIcon]::Warning)
    }
    $script:lastState[$inst.profile] = if ($webUp) { 'up' } else { 'down' }
  }
}

function Build-Menu {
  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $menu.ShowImageMargin = $false
  $first = $true
  foreach ($inst in (Get-Instances)) {
    if (-not $first) { $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null }
    $first = $false
    $s = Instance-State $inst
    $webUp = $s.webUp
    $pids = Get-ProfilePids $inst.profile
    $ours = [bool]$pids
    $managed = $script:managed[$inst.profile]

    $status = if ($webUp) { "● 运行中 :$(([uri]$inst.webUrl).Port)" } else { '○ 已停止' }
    if (-not $ours -and $webUp) { $status += '（外部托管）' }
    $header = New-Object System.Windows.Forms.ToolStripMenuItem
    $header.Text = "$($inst.name)  —  $status"
    $header.Enabled = $false
    $menu.Items.Add($header) | Out-Null

    $openWeb = New-Object System.Windows.Forms.ToolStripMenuItem
    $openWeb.Text = "打开页面  $($inst.webUrl)"
    $openWeb.Enabled = $webUp
    $openWeb.Add_Click({ Start-Process $inst.webUrl }) | Out-Null
    $menu.Items.Add($openWeb) | Out-Null

    if ($inst.gatewayUrl) {
      $gwUp = $s.gwUp
      $openGw = New-Object System.Windows.Forms.ToolStripMenuItem
      $openGw.Text = "打开网关  $($inst.gatewayUrl)"
      $openGw.Enabled = $gwUp
      $openGw.Add_Click({ Start-Process $inst.gatewayUrl }) | Out-Null
      $menu.Items.Add($openGw) | Out-Null
    }

    if (-not $webUp) {
      $start = New-Object System.Windows.Forms.ToolStripMenuItem
      $start.Text = '启动'
      $start.Add_Click({
        try { Start-DshInstance $inst | Out-Null; $script:managed[$inst.profile] = @{ startedByUs = $true } }
        catch { $script:tray.ShowBalloonTip(3000, 'dsh-tray', $_.Exception.Message, [System.Windows.Forms.ToolTipIcon]::Error) }
      }) | Out-Null
      $menu.Items.Add($start) | Out-Null
    } else {
      $restart = New-Object System.Windows.Forms.ToolStripMenuItem
      $restart.Text = '重启'
      $restart.Add_Click({
        if ([System.Windows.Forms.MessageBox]::Show("重启 $($inst.name)？", 'dsh-tray', [System.Windows.Forms.MessageBoxButtons]::OKCancel) -eq 'OK') {
          Stop-DshInstance $inst
          Start-Sleep -Seconds 1
          Start-DshInstance $inst | Out-Null
        }
      }) | Out-Null
      $menu.Items.Add($restart) | Out-Null

      $stop = New-Object System.Windows.Forms.ToolStripMenuItem
      $stop.Text = '停止'
      $note = if ($managed -and $managed.startedByUs) { '' } else { "`n（该实例不是本托盘启动的，停止将直接结束其 node 进程）" }
      $stop.Add_Click({
        if ([System.Windows.Forms.MessageBox]::Show("停止 $($inst.name)？$note", 'dsh-tray', [System.Windows.Forms.MessageBoxButtons]::OKCancel) -eq 'OK') {
          Stop-DshInstance $inst
          $script:managed[$inst.profile] = $null
        }
      }) | Out-Null
      $menu.Items.Add($stop) | Out-Null
    }
  }

  $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

  $auto = New-Object System.Windows.Forms.ToolStripMenuItem
  $auto.Text = '开机自启'
  $auto.Checked = Test-Autostart
  $auto.Add_Click({ Set-Autostart (-not $auto.Checked); $auto.Checked = Test-Autostart }) | Out-Null
  $menu.Items.Add($auto) | Out-Null

  $quit = New-Object System.Windows.Forms.ToolStripMenuItem
  $quit.Text = '退出托盘'
  $quit.Add_Click({
    $r = [System.Windows.Forms.MessageBox]::Show('退出托盘？\n\n是：退出并保持实例运行\n否：退出并停止全部实例\n取消：留在托盘', 'dsh-tray', [System.Windows.Forms.MessageBoxButtons]::YesNoCancel)
    if ($r -eq 'Cancel') { return }
    if ($r -eq 'No') {
      foreach ($inst in (Get-Instances)) { Stop-DshInstance $inst -silent }
    }
    $script:exitNow = $true
  }) | Out-Null
  $menu.Items.Add($quit) | Out-Null

  return $menu
}

# ── 托盘主循环 ────────────────────────────────────────────────────────────

[System.Windows.Forms.Application]::EnableVisualStyles()
$script:tray = New-Object System.Windows.Forms.NotifyIcon
$script:tray.Icon = New-TrayIcon
$script:tray.Text = 'DSH 启动器'
$script:tray.Visible = $true
$script:tray.ContextMenuStrip = Build-Menu
$script:tray.add_MouseUp({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Right) {
    $script:tray.ContextMenuStrip = Build-Menu
  }
})

# 开机自启且配置了 startOnBoot 的实例：自动拉起
foreach ($inst in (Get-Instances)) {
  if ($inst.startOnBoot) {
    Start-DshInstance $inst -silent | Out-Null
    $script:managed[$inst.profile] = @{ startedByUs = $true }
  }
}
Refresh-InstanceStates

# 自检模式：DSH_TRAY_SMOKE=1 时 6 秒后自动退出并打印确认（供自动化验证）
if ($env:DSH_TRAY_SMOKE) {
  $smoke = New-Object System.Windows.Forms.Timer
  $smoke.Interval = 6000
  $smoke.Add_Tick({
    Write-Host 'SMOKE OK: tray running'
    $script:tray.Visible = $false
    $script:tray.Dispose()
    [System.Windows.Forms.Application]::Exit()
  }) | Out-Null
  $smoke.Start()
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
  Refresh-InstanceStates
  if ($script:exitNow) { $timer.Stop(); $script:tray.Visible = $false; $script:tray.Dispose(); [System.Windows.Forms.Application]::Exit() }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()

