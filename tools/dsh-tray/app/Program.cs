// dsh-tray — native WinForms tray launcher for DeepSeek Harness instances.
// Hides the dsh console, lives in the notification area, and manages
// start/stop/restart per instance. Config: config.json next to the exe.

using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Management;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace DshTray;

internal sealed class InstanceConfig
{
    public string Name { get; set; } = "";
    public string Profile { get; set; } = "";
    public List<string> Args { get; set; } = new();
    public string WebUrl { get; set; } = "";
    public string? GatewayUrl { get; set; }
    public bool StartOnBoot { get; set; }
}

internal static class Program
{
    private static readonly string ExeDir = AppContext.BaseDirectory;
    private static readonly string ConfigPath = Path.Combine(ExeDir, "config.json");
    private static readonly string LogDir = Path.Combine(ExeDir, "logs");

    private static List<InstanceConfig> _instances = new();
    private static NotifyIcon? _tray;
    private static readonly Dictionary<string, bool> StartedByUs = new();
    private static readonly Dictionary<string, string> LastState = new();

    // 状态缓存：UI 线程只读缓存，后台线程刷新（避免 WMI/端口探测卡 UI）
    private static readonly object CacheLock = new();
    private static readonly Dictionary<string, (bool webUp, bool gwUp, List<int> pids)> StateCache = new();
    private static HashSet<int> _listeningPorts = new();

    [STAThread]
    private static void Main(string[] args)
    {
        Directory.CreateDirectory(LogDir);
        _instances = LoadConfig();
        Log($"tray started (pid {Environment.ProcessId}, {_instances.Count} instance(s))");

        ApplicationConfiguration.Initialize();
        using var context = new ApplicationContext();

        RefreshCache(); // 首次同步刷新（一次性约 1s），保证初始菜单状态准确

        _tray = new NotifyIcon
        {
            Icon = MakeIcon(),
            Text = "DSH 启动器",
            Visible = true,
            ContextMenuStrip = BuildMenu(),
        };
        _tray.MouseUp += (_, e) =>
        {
            if (e.Button == MouseButtons.Right) _tray.ContextMenuStrip = BuildMenu();
        };

        if (_instances.Any(i => i.StartOnBoot))
            foreach (var inst in _instances.Where(i => i.StartOnBoot))
                StartInstance(inst);

        // 后台每 2 秒刷新状态缓存（监听端口 + 实例 pids），查询都在工作线程，不卡 UI
        using var refreshTimer = new System.Threading.Timer(_ => RefreshCache(), null, 0, 2000);

        using var timer = new System.Windows.Forms.Timer { Interval = 3000 };
        timer.Tick += (_, _) => RefreshStates();
        timer.Start();

        Application.Run(context);
        refreshTimer.Dispose();
        _tray.Visible = false;
    }

    // ── config / helpers ────────────────────────────────────────────────────

    private static List<InstanceConfig> LoadConfig()
    {
        try
        {
            var json = File.ReadAllText(ConfigPath);
            var doc = JsonSerializer.Deserialize<JsonElement>(json);
            return doc.GetProperty("instances").EnumerateArray()
                .Select(el => new InstanceConfig
                {
                    Name = Get(el, "name"),
                    Profile = Get(el, "profile"),
                    Args = el.TryGetProperty("args", out var a) && a.ValueKind == JsonValueKind.Array
                        ? a.EnumerateArray().Select(x => x.GetString() ?? "").ToList() : new List<string>(),
                    WebUrl = Get(el, "webUrl"),
                    GatewayUrl = el.TryGetProperty("gatewayUrl", out var g) && g.ValueKind == JsonValueKind.String ? g.GetString() : null,
                    StartOnBoot = el.TryGetProperty("startOnBoot", out var s) && s.ValueKind == JsonValueKind.True,
                }).ToList();
        }
        catch (Exception ex)
        {
            Log($"config load failed: {ex.Message}");
            return new List<InstanceConfig>();
        }
    }

    private static string Get(JsonElement el, string key)
        => el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    private static void Log(string line) => File.AppendAllText(Path.Combine(LogDir, "tray.log"), $"{DateTime.Now:HH:mm:ss} {line}\r\n");

    private static int PortOf(string url) => new Uri(url).Port;

    // 实时端口探测（UI 线程兜底用）：本地探测 150ms 足够，未监听端口会吃满超时所以必须短
    private static bool PortListening(int port)
    {
        if (port <= 0) return false;
        try
        {
            using var client = new TcpClient();
            var ar = client.BeginConnect("127.0.0.1", port, null, null);
            return ar.AsyncWaitHandle.WaitOne(150) && client.Connected;
        }
        catch { return false; }
    }

    // 监听端口集合（后台刷新缓存，O(1) 判断）
    private static bool PortInCache(int port) { lock (CacheLock) return _listeningPorts.Contains(port); }

    // 后台刷新：一次查全量监听端口 + 每个实例的 pids，写入缓存。
    // 注意：WMI 查询在锁外完成（约 1s），锁内只做字典赋值，避免阻塞 UI 线程读缓存
    private static void RefreshCache()
    {
        try
        {
            var ports = new HashSet<int>();
            try
            {
                using var searcher = new ManagementObjectSearcher(@"root\standardcimv2",
                    "SELECT LocalPort FROM MSFT_NetTCPConnection WHERE State=2");
                foreach (var o in searcher.Get())
                {
                    if (o["LocalPort"] != null)
                        ports.Add(Convert.ToInt32(o["LocalPort"]));
                }
            }
            catch (Exception ex) { Log($"listen-port query failed: {ex.Message}"); }

            var snap = new Dictionary<string, (bool webUp, bool gwUp, List<int> pids)>();
            foreach (var inst in _instances)
            {
                int wp = PortOf(inst.WebUrl);
                bool webUp = wp > 0 && ports.Contains(wp);
                bool gwUp = inst.GatewayUrl != null && ports.Contains(PortOf(inst.GatewayUrl!));
                snap[inst.Profile] = (webUp, gwUp, ProfilePids(inst.Profile, wp)); // 锁外查询
            }

            lock (CacheLock)
            {
                _listeningPorts = ports;
                foreach (var kv in snap) StateCache[kv.Key] = kv.Value;
            }
        }
        catch (Exception ex) { Log($"refresh cache failed: {ex.Message}"); }
    }

    private static (bool webUp, bool gwUp, List<int> pids) CachedState(InstanceConfig inst)
    {
        lock (CacheLock)
            if (StateCache.TryGetValue(inst.Profile, out var s)) return s;
        return (false, false, new List<int>());
    }

    private static List<int> ProfilePids(string profile, int webPort)
    {
        var pids = new List<int>();
        try
        {
            // 通道 1：命令行精确匹配（管理员可读时优先，见 test 用例）
            var pattern = $@"--profile(?:=|\s+)['""]?{Regex.Escape(profile)}['""]?(?=\s|$)";
            using var searcher = new ManagementObjectSearcher(
                $"SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'");
            foreach (var obj in searcher.Get())
            {
                var cl = obj["CommandLine"] as string;
                if (cl != null && Regex.IsMatch(cl, pattern))
                    pids.Add(Convert.ToInt32(obj["ProcessId"]));
            }
            if (pids.Count > 0) return pids;

            // 通道 2：web 端口反查 PID（命令行不可读时的兜底——实测管理员也读不到部分进程命令行）
            if (webPort > 0)
            {
                using var conn = new ManagementObjectSearcher(@"root\standardcimv2",
                    $"SELECT OwningProcess FROM MSFT_NetTCPConnection WHERE LocalPort={webPort} AND State=2");
                foreach (var obj in conn.Get())
                {
                    var pid = Convert.ToInt32(obj["OwningProcess"]);
                    if (pid > 0 && !pids.Contains(pid)) pids.Add(pid);
                }
            }
        }
        catch (Exception ex) { Log($"pid query failed: {ex.Message}"); }
        return pids;
    }

    private static (bool webUp, bool gwUp) StateOf(InstanceConfig inst)
    {
        var s = CachedState(inst);
        return (s.webUp, s.gwUp);
    }

    // ── instance lifecycle ──────────────────────────────────────────────────

    private static void StartInstance(InstanceConfig inst)
    {
        if (CachedState(inst).pids.Count > 0)
        {
            _tray?.ShowBalloonTip(3000, "dsh-tray", $"{inst.Name} 已在运行", ToolTipIcon.Info);
            return;
        }

        // 启动前检查端口占用：占用了再启动只会 EADDRINUSE 静默失败（读缓存，秒回）
        var occupied = new List<string>();
        int webPort = PortOf(inst.WebUrl);
        if (webPort > 0 && PortInCache(webPort)) occupied.Add($"web:{webPort}");
        if (inst.GatewayUrl != null)
        {
            int gwPort = PortOf(inst.GatewayUrl);
            if (gwPort > 0 && PortInCache(gwPort)) occupied.Add($"网关:{gwPort}");
        }
        if (occupied.Count > 0)
        {
            var msg = $"{inst.Name} 未启动：端口 {string.Join("、", occupied)} 已被占用。\r\n可能实例已在运行，或其它程序占用了端口。";
            _tray?.ShowBalloonTip(5000, "dsh-tray", msg, ToolTipIcon.Warning);
            Log($"start {inst.Profile} skipped: port occupied ({string.Join(",", occupied)})");
            return;
        }

        var args = $"/c dsh --profile {inst.Profile}";
        if (inst.Args.Count > 0) args += " " + string.Join(" ", inst.Args);
        try
        {
            var psi = new ProcessStartInfo("cmd.exe", args)
            {
                WindowStyle = ProcessWindowStyle.Hidden,
                CreateNoWindow = true,
                UseShellExecute = false,
            };
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            proc.OutputDataReceived += (_, e) => { if (e.Data != null) File.AppendAllText(LogPath(inst, ".out.log"), e.Data + "\r\n"); };
            proc.ErrorDataReceived += (_, e) => { if (e.Data != null) File.AppendAllText(LogPath(inst, ".err.log"), e.Data + "\r\n"); };
            if (proc.Start())
            {
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                StartedByUs[inst.Profile] = true;
                Log($"started {inst.Profile}");
                ThreadPool.QueueUserWorkItem(_ => RefreshCache()); // 立即刷新状态，不等后台定时器
            }
        }
        catch (Exception ex)
        {
            Log($"start {inst.Profile} failed: {ex.Message}");
            _tray?.ShowBalloonTip(3000, "dsh-tray", $"启动 {inst.Name} 失败：{ex.Message}", ToolTipIcon.Error);
        }
    }

    private static string LogPath(InstanceConfig inst, string suffix) => Path.Combine(LogDir, inst.Profile + suffix);

    private static void StopInstance(InstanceConfig inst)
    {
        var pids = CachedState(inst).pids;
        if (pids.Count == 0)
            pids = ProfilePids(inst.Profile, PortOf(inst.WebUrl)); // 缓存未刷新时实时兜底（双通道）
        if (pids.Count == 0)
        {
            _tray?.ShowBalloonTip(3000, "dsh-tray", $"{inst.Name}：未找到该实例的进程（web 端口无监听，或进程查询失败）", ToolTipIcon.Warning);
            Log($"stop {inst.Profile}: no matching node process found");
            StartedByUs[inst.Profile] = false;
            return;
        }
        // taskkill /T 连子进程一起杀，避免 node 残留导致端口不释放
        foreach (var pid in pids)
        {
            try
            {
                var psi = new ProcessStartInfo("taskkill", $"/F /T /PID {pid}")
                {
                    WindowStyle = ProcessWindowStyle.Hidden,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                };
                var p = Process.Start(psi);
                p?.WaitForExit(5000);
                if (p != null && p.HasExited && p.ExitCode != 0 && p.ExitCode != 128)
                    Log($"taskkill {pid} exit {p.ExitCode}");
                else
                    Log($"killed process tree of pid {pid}");
            }
            catch (Exception ex) { Log($"taskkill {pid} failed: {ex.Message}"); }
        }
        StartedByUs[inst.Profile] = false;
        _tray?.ShowBalloonTip(3000, "dsh-tray", $"{inst.Name} 已停止（{pids.Count} 个进程树）", ToolTipIcon.Info);
        Log($"stopped {inst.Profile}: {pids.Count} process tree(s)");
        ThreadPool.QueueUserWorkItem(_ => RefreshCache()); // 停止后立即刷新状态
    }

    // 等待端口释放（强杀后端口可能延迟释放），超时返回 false
    // 在 UI 线程上轮询，需泵消息避免托盘冻结
    private static bool WaitPortFree(int port, int timeoutMs)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            if (!PortListening(port)) return true;
            Application.DoEvents();
            Thread.Sleep(500);
        }
        return !PortListening(port);
    }

    // ── menu ────────────────────────────────────────────────────────────────

    private static ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip { ShowImageMargin = false };
        var first = true;
        foreach (var inst in _instances)
        {
            if (!first) menu.Items.Add(new ToolStripSeparator());
            first = false;
            var (webUp, gwUp) = StateOf(inst);
            var pids = CachedState(inst).pids;
            var ours = pids.Count > 0;
            var byUs = StartedByUs.TryGetValue(inst.Profile, out var startedByUs) && startedByUs;
            var status = webUp ? $"● 运行中 :{PortOf(inst.WebUrl)}" : "○ 已停止";
            if (ours && !byUs) status += "（外部托管）";

            var header = new ToolStripMenuItem($"{inst.Name}  —  {status}") { Enabled = false };
            menu.Items.Add(header);

            var openWeb = new ToolStripMenuItem($"打开页面  {inst.WebUrl}") { Enabled = webUp };
            openWeb.Click += (_, _) => OpenUrl(inst.WebUrl);
            menu.Items.Add(openWeb);

            if (inst.GatewayUrl != null)
            {
                var openGw = new ToolStripMenuItem($"打开网关  {inst.GatewayUrl}") { Enabled = gwUp };
                openGw.Click += (_, _) => OpenUrl(inst.GatewayUrl!);
                menu.Items.Add(openGw);
            }

            if (!webUp)
            {
                var start = new ToolStripMenuItem("启动");
                start.Click += (_, _) => StartInstance(inst);
                menu.Items.Add(start);
            }
            else
            {
                var restart = new ToolStripMenuItem("重启");
                restart.Click += (_, _) =>
                {
                    if (!Confirm($"重启 {inst.Name}？")) return;
                    StopInstance(inst);
                    if (!WaitPortFree(PortOf(inst.WebUrl), 6000))
                        Log($"restart {inst.Profile}: web port {PortOf(inst.WebUrl)} still busy after stop");
                    StartInstance(inst);
                };
                menu.Items.Add(restart);

                var stop = new ToolStripMenuItem("停止");
                var note = byUs ? "" : "\r\n（该实例不是本托盘启动的，停止将直接结束其 node 进程）";
                stop.Click += (_, _) =>
                {
                    if (Confirm($"停止 {inst.Name}？{note}")) StopInstance(inst);
                };
                menu.Items.Add(stop);
            }
        }

        menu.Items.Add(new ToolStripSeparator());
        var auto = new ToolStripMenuItem("开机自启") { Checked = IsAutostart() };
        auto.Click += (_, _) => { SetAutostart(!IsAutostart()); auto.Checked = IsAutostart(); };
        menu.Items.Add(auto);

        var quit = new ToolStripMenuItem("退出托盘");
        quit.Click += (_, _) =>
        {
            var r = MessageBox.Show("退出托盘？\r\n\r\n是：退出并保持实例运行\r\n否：退出并停止全部实例\r\n取消：留在托盘",
                "dsh-tray", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
            if (r == DialogResult.Cancel) return;
            if (r == DialogResult.No) foreach (var inst in _instances) StopInstance(inst);
            _tray!.Visible = false;
            Application.Exit();
        };
        menu.Items.Add(quit);
        return menu;
    }

    private static bool Confirm(string message)
        => MessageBox.Show(message, "dsh-tray", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK;

    private static void OpenUrl(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception ex) { Log($"open url failed: {ex.Message}"); }
    }

    // ── status refresh / crash detection ────────────────────────────────────

    private static void RefreshStates()
    {
        foreach (var inst in _instances)
        {
            var (webUp, _) = StateOf(inst);
            var prev = LastState.GetValueOrDefault(inst.Profile);
            var byUs = StartedByUs.GetValueOrDefault(inst.Profile);
            if (prev == "down" && webUp && byUs)
                _tray?.ShowBalloonTip(3000, "dsh-tray", $"{inst.Name} 已就绪", ToolTipIcon.Info);
            if (prev == "up" && !webUp && byUs)
            {
                var tail = "";
                var err = LogPath(inst, ".err.log");
                if (File.Exists(err))
                    tail = "：" + string.Join(" ", File.ReadLines(err).TakeLast(3)).Trim();
                _tray?.ShowBalloonTip(5000, "dsh-tray", $"{inst.Name} 异常退出{tail}", ToolTipIcon.Warning);
            }
            LastState[inst.Profile] = webUp ? "up" : "down";
        }
    }

    // ── autostart ───────────────────────────────────────────────────────────

    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    private static bool IsAutostart()
    {
        try { return Registry.CurrentUser.OpenSubKey(RunKey)?.GetValue("dsh-tray") != null; }
        catch { return false; }
    }

    private static void SetAutostart(bool on)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKey);
            if (on) key.SetValue("dsh-tray", $"\"{Environment.ProcessPath}\"");
            else key.DeleteValue("dsh-tray", false);
        }
        catch (Exception ex) { Log($"autostart toggle failed: {ex.Message}"); }
    }

    // ── icon ────────────────────────────────────────────────────────────────

    private static Icon MakeIcon()
    {
        // The bitmap must outlive the Icon: Icon.FromHandle wraps the hicon,
        // which dies with its bitmap, so disposing the bitmap here would leave
        // a valid-looking-but-invisible tray icon. One 16x16 leak is fine.
        var bmp = new Bitmap(16, 16);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using var bg = new SolidBrush(Color.FromArgb(57, 100, 254));
            g.FillEllipse(bg, 0, 0, 16, 16);
            using var font = new Font("Segoe UI", 9f, FontStyle.Bold, GraphicsUnit.Pixel);
            using var fg = new SolidBrush(Color.White);
            g.DrawString("G", font, fg, 3f, 1f);
        }
        return Icon.FromHandle(bmp.GetHicon());
    }
}
