// dsh-tray — native WinForms tray launcher for DeepSeek Harness instances.
// Hides the dsh console, lives in the notification area, and manages
// start/stop/restart per instance. Config: config.json next to the exe.

using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.Json;
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

    // 状态缓存：UI 线程只读缓存，后台线程刷新（原生端口表毫秒级，无 WMI）
    private static readonly object CacheLock = new();
    private static readonly Dictionary<string, (bool webUp, bool gwUp, List<int> pids)> StateCache = new();
    private static string _menuSig = "";   // 上次重建菜单时的状态签名（变化才重建）
    private static bool _menuOpen;         // 菜单是否展开（展开时不重建，避免打断）

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
        _menuSig = MenuSig();
        _tray.MouseUp += (_, e) =>
        {
            if (e.Button == MouseButtons.Right)
            {
                RefreshCache(); // 原生端口表毫秒级：点右键即读到最新状态
                _tray.ContextMenuStrip = BuildMenu();
            }
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

    // 原生端口表（一次调用拿全量监听端口 + 所属 PID，毫秒级，替代三套 WMI 查询）
    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(IntPtr pTcpTable, ref int pdwSize, bool bOrder,
        int ulAf, int tableClass, int reserved);

    private static int NetPort(uint v) => ((int)(v & 0xFF) << 8) | (int)((v >> 8) & 0xFF);

    private static (HashSet<int> ports, Dictionary<int, List<int>> pidByPort) GetTcpListeners()
    {
        var ports = new HashSet<int>();
        var pidByPort = new Dictionary<int, List<int>>();
        foreach (var af in new[] { 2, 23 }) // AF_INET / AF_INET6
        {
            int size = 0;
            GetExtendedTcpTable(IntPtr.Zero, ref size, false, af, 3, 0); // TCP_TABLE_OWNER_PID_LISTENER=3
            if (size <= 0) continue;
            var buf = Marshal.AllocHGlobal(size);
            try
            {
                if (GetExtendedTcpTable(buf, ref size, false, af, 3, 0) != 0) continue;
                int count = Marshal.ReadInt32(buf);
                int off = 4;
                int portOff = af == 2 ? 8 : 20;  // 行内 local port 偏移
                int pidOff = af == 2 ? 20 : 44;  // 行内 owning pid 偏移
                int rowSize = af == 2 ? 24 : 48;
                for (int i = 0; i < count; i++)
                {
                    int port = NetPort((uint)Marshal.ReadInt32(buf, off + portOff));
                    int pid = Marshal.ReadInt32(buf, off + pidOff);
                    off += rowSize;
                    if (port <= 0 || pid <= 0) continue;
                    ports.Add(port);
                    if (!pidByPort.TryGetValue(port, out var list)) { list = new List<int>(); pidByPort[port] = list; }
                    if (!list.Contains(pid)) list.Add(pid);
                }
            }
            finally { Marshal.FreeHGlobal(buf); }
        }
        return (ports, pidByPort);
    }

    // 实例对应的进程：web + 网关端口的所有者 PID 并集
    private static List<int> PidsFor(InstanceConfig inst, Dictionary<int, List<int>> pidByPort)
    {
        var pids = new List<int>();
        foreach (var p in new[] { PortOf(inst.WebUrl), inst.GatewayUrl != null ? PortOf(inst.GatewayUrl) : -1 })
        {
            if (p <= 0 || !pidByPort.TryGetValue(p, out var owners)) continue;
            foreach (var pid in owners) if (!pids.Contains(pid)) pids.Add(pid);
        }
        return pids;
    }

    private static bool IsNodeProcess(int pid)
    {
        try { using var p = Process.GetProcessById(pid); return string.Equals(p.ProcessName, "node", StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }

    // 后台刷新：原生端口表（毫秒级），锁外查询、锁内赋值
    private static void RefreshCache()
    {
        try
        {
            var (ports, pidByPort) = GetTcpListeners();
            var snap = new Dictionary<string, (bool webUp, bool gwUp, List<int> pids)>();
            foreach (var inst in _instances)
            {
                int wp = PortOf(inst.WebUrl);
                bool webUp = wp > 0 && ports.Contains(wp);
                bool gwUp = inst.GatewayUrl != null && ports.Contains(PortOf(inst.GatewayUrl!));
                snap[inst.Profile] = (webUp, gwUp, PidsFor(inst, pidByPort));
            }
            lock (CacheLock) { foreach (var kv in snap) StateCache[kv.Key] = kv.Value; }
        }
        catch (Exception ex) { Log($"refresh cache failed: {ex.Message}"); }
    }

    private static (bool webUp, bool gwUp, List<int> pids) CachedState(InstanceConfig inst)
    {
        lock (CacheLock)
            if (StateCache.TryGetValue(inst.Profile, out var s)) return s;
        return (false, false, new List<int>());
    }

    private static (bool webUp, bool gwUp) StateOf(InstanceConfig inst)
    {
        var s = CachedState(inst);
        return (s.webUp, s.gwUp);
    }

    // ── instance lifecycle ──────────────────────────────────────────────────

    private static void StartInstance(InstanceConfig inst)
    {
        // 实时探测（原生端口表毫秒级）：不再读可能过期的缓存——重启/停止后立即启动也能拿到最新状态
        var (livePorts, pidByPort) = GetTcpListeners();
        var livePids = PidsFor(inst, pidByPort);
        if (livePids.Count > 0)
        {
            bool allNode = livePids.All(IsNodeProcess);
            if (allNode)
                _tray?.ShowBalloonTip(3000, "dsh-tray", $"{inst.Name} 已在运行", ToolTipIcon.Info);
            else
            {
                var msg = $"{inst.Name} 未启动：端口已被其它程序占用（进程 {string.Join(",", livePids)}）。";
                _tray?.ShowBalloonTip(5000, "dsh-tray", msg, ToolTipIcon.Warning);
                Log($"start {inst.Profile} skipped: ports owned by non-node process ({string.Join(",", livePids)})");
            }
            return;
        }

        // 端口占用兜底检查（端口在监听必有 owner pid，此处覆盖 pid 解析不到的边界）
        var occupied = new List<string>();
        int webPort = PortOf(inst.WebUrl);
        if (webPort > 0 && livePorts.Contains(webPort)) occupied.Add($"web:{webPort}");
        if (inst.GatewayUrl != null)
        {
            int gwPort = PortOf(inst.GatewayUrl);
            if (gwPort > 0 && livePorts.Contains(gwPort)) occupied.Add($"网关:{gwPort}");
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
                RefreshCache(); // 立即刷新状态（毫秒级），不等后台定时器
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
        var (_, pidByPort) = GetTcpListeners();
        var pids = PidsFor(inst, pidByPort); // 实时端口表：杀的就是当前监听这两个端口的进程
        if (pids.Count == 0)
        {
            _tray?.ShowBalloonTip(3000, "dsh-tray", $"{inst.Name}：未找到该实例的进程（web 端口无监听）", ToolTipIcon.Warning);
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
        RefreshCache(); // 立即刷新状态（毫秒级）
    }

    // 等待端口释放（强杀后端口可能延迟释放），超时返回 false；在 UI 线程上轮询，需泵消息避免托盘冻结
    private static bool WaitPortsFree(IReadOnlyList<int> ports, int timeoutMs)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            bool busy = false;
            foreach (var port in ports)
                if (port > 0 && PortListening(port)) { busy = true; break; }
            if (!busy) return true;
            Application.DoEvents();
            Thread.Sleep(500);
        }
        foreach (var port in ports)
            if (port > 0 && PortListening(port)) return false;
        return true;
    }

    // ── menu ────────────────────────────────────────────────────────────────

    private static ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip { ShowImageMargin = false };
        menu.Opening += (_, _) => _menuOpen = true;
        menu.Closed += (_, _) => _menuOpen = false;
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
                    var ports = new[] { PortOf(inst.WebUrl), inst.GatewayUrl != null ? PortOf(inst.GatewayUrl) : -1 };
                    if (!WaitPortsFree(ports, 6000))
                        Log($"restart {inst.Profile}: ports still busy after stop");
                    StartInstance(inst); // 启动前检查是实时的：端口/进程已释放即可立即起来
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

    private static string MenuSig()
        => string.Join("|", _instances.Select(i => $"{i.Profile}:{StateOf(i).webUp}:{StateOf(i).gwUp}"));

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

        // 状态变化时自动重建菜单（展开中不打断，收起后下次 tick 即更新）——不用反复点击也能看到最新状态
        if (_menuOpen) return;
        var sig = MenuSig();
        if (sig != _menuSig)
        {
            _menuSig = sig;
            _tray!.ContextMenuStrip = BuildMenu();
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
        // Prefer the multi-resolution icon embedded in this exe, so the tray
        // icon and the program icon are the same asset. Fall back to a
        // runtime-drawn one only if extraction fails.
        var embedded = Icon.ExtractAssociatedIcon(Environment.ProcessPath!);
        if (embedded != null) return embedded;
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
