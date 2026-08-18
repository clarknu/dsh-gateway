// icon-gen — draws the dsh-tray application icon at multiple resolutions and
// packs them into one .ico (PNG-compressed frames, supported by Windows Vista+;
// fine for Explorer, taskbar, alt-tab). Run: dotnet run --project icon-gen
//
// Design: blue circle (#3964FE) with a white bold "G" — matches the tray icon.

using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

var sizes = new[] { 16, 24, 32, 48, 64, 128, 256 };
var frames = new List<(int size, byte[] data)>();

foreach (var size in sizes)
{
    using var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp))
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using var bg = new SolidBrush(Color.FromArgb(57, 100, 254));
        g.FillEllipse(bg, 0, 0, size, size);
        using var font = new Font("Segoe UI", size * 0.55f, FontStyle.Bold, GraphicsUnit.Pixel);
        using var fg = new SolidBrush(Color.White);
        var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        g.DrawString("G", font, fg, new RectangleF(0, size * 0.02f, size, size * 0.98f), format);
    }
    using var ms = new MemoryStream();
    bmp.Save(ms, ImageFormat.Png);
    frames.Add((size, ms.ToArray()));
}

var outPath = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "dsh-tray.ico");
outPath = Path.GetFullPath(outPath);
using var ico = File.Create(outPath);
using var bw = new BinaryWriter(ico);
bw.Write((ushort)0);
bw.Write((ushort)1);
bw.Write((ushort)frames.Count);
foreach (var f in frames)
{
    bw.Write((byte)(f.size >= 256 ? 0 : f.size));
    bw.Write((byte)(f.size >= 256 ? 0 : f.size));
    bw.Write((byte)0);
    bw.Write((byte)0);
    bw.Write((ushort)1); // planes
    bw.Write((ushort)32); // bitcount
    bw.Write(f.data.Length);
    bw.Write(0);
}
long offset = 6 + 16 * frames.Count;
for (var i = 0; i < frames.Count; i++)
{
    var pos = 6 + 16 * i + 12;
    var saved = bw.BaseStream.Position;
    bw.BaseStream.Position = pos;
    bw.Write((int)offset);
    bw.BaseStream.Position = saved;
    bw.Write(frames[i].data);
    offset += frames[i].data.Length;
}
bw.Flush();
Console.WriteLine($"wrote {outPath} ({frames.Count} sizes: {string.Join(",", sizes)})");
