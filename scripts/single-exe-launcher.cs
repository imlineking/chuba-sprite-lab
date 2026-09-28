// One-file launcher for the fully offline Sprite Lab bundle. The 7z archive,
// extractor and its licence are appended after this PE image by build-single-exe.mjs.
// The first launch verifies and unpacks into LocalAppData; later launches reuse it.
using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class SingleExeLauncher {
  private const int FooterLength = 88;
  private const string Magic = "CHUBASFX";

  [STAThread]
  private static int Main(string[] args) {
    string logPath = null;
    try {
      string basePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ChubaSpriteLab", "offline");
      Directory.CreateDirectory(basePath);
      logPath = Path.Combine(basePath, "launcher.log");
      string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
      using (FileStream source = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read)) {
        if (source.Length < FooterLength) throw new InvalidDataException("Bundle footer is missing.");
        source.Seek(-FooterLength, SeekOrigin.End);
        using (BinaryReader footer = new BinaryReader(source, Encoding.ASCII, true)) {
          if (Encoding.ASCII.GetString(footer.ReadBytes(8)) != Magic) throw new InvalidDataException("Bundle footer is invalid.");
          long extractorOffset = footer.ReadInt64(), extractorLength = footer.ReadInt64();
          long licenseOffset = footer.ReadInt64(), licenseLength = footer.ReadInt64();
          long archiveOffset = footer.ReadInt64(), archiveLength = footer.ReadInt64();
          byte[] expectedHash = footer.ReadBytes(32);
          if (!ValidPart(extractorOffset, extractorLength, source.Length) || !ValidPart(licenseOffset, licenseLength, source.Length)
            || !ValidPart(archiveOffset, archiveLength, source.Length) || expectedHash.Length != 32)
            throw new InvalidDataException("Bundle offsets are invalid.");
          string digest = BitConverter.ToString(expectedHash).Replace("-", "").ToLowerInvariant();
          string cache = Path.Combine(basePath, digest.Substring(0, 24));
          string appExe = Path.Combine(cache, "Chuba Sprite Lab.exe");
          string marker = Path.Combine(cache, ".ready");
          using (Mutex mutex = new Mutex(false, "Local\\ChubaSpriteLab-" + digest.Substring(0, 24))) {
            bool acquired = false;
            try {
              try { acquired = mutex.WaitOne(TimeSpan.FromMinutes(30)); }
              catch (AbandonedMutexException) { acquired = true; }
              if (!acquired) throw new TimeoutException("Another launch is still unpacking Sprite Lab.");
              if (!File.Exists(appExe) || !File.Exists(marker) || File.ReadAllText(marker).Trim() != digest)
                Extract(source, basePath, cache, extractorOffset, extractorLength, licenseOffset, licenseLength, archiveOffset, archiveLength, expectedHash, digest);
            } finally { if (acquired) mutex.ReleaseMutex(); }
          }
          ProcessStartInfo start = new ProcessStartInfo(appExe);
          start.WorkingDirectory = cache;
          start.UseShellExecute = false;
          start.CreateNoWindow = false;
          start.Arguments = JoinArguments(args);
          start.EnvironmentVariables["PORTABLE_EXECUTABLE_DIR"] = Path.GetDirectoryName(self);
          start.EnvironmentVariables["PORTABLE_EXECUTABLE_FILE"] = self;
          start.EnvironmentVariables["PORTABLE_EXECUTABLE_APP_FILENAME"] = "chuba-sprite-lab";
          using (Process child = Process.Start(start)) {
            if (child == null) throw new IOException("Sprite Lab could not start.");
            child.WaitForExit();
            return child.ExitCode;
          }
        }
      }
    } catch (Exception error) {
      try { if (logPath != null) File.AppendAllText(logPath, DateTime.Now.ToString("O") + " " + error + Environment.NewLine); } catch { }
      if (Array.IndexOf(args, "--self-test") < 0)
        MessageBox.Show("Не удалось открыть Chuba Sprite Lab. Подробности: " + logPath + Environment.NewLine + error.Message,
          "Chuba Sprite Lab", MessageBoxButtons.OK, MessageBoxIcon.Error);
      return 1;
    }
  }

  private static bool ValidPart(long offset, long length, long fileLength) {
    return offset >= 0 && length > 0 && offset <= fileLength - FooterLength && length <= fileLength - FooterLength - offset;
  }

  private static void CopyPart(FileStream source, long offset, long length, string destination, SHA256 hash) {
    source.Seek(offset, SeekOrigin.Begin);
    byte[] buffer = new byte[1024 * 1024];
    using (FileStream target = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
      while (length > 0) {
        int count = source.Read(buffer, 0, (int)Math.Min(buffer.Length, length));
        if (count <= 0) throw new EndOfStreamException("Bundle is truncated.");
        target.Write(buffer, 0, count);
        if (hash != null) hash.TransformBlock(buffer, 0, count, buffer, 0);
        length -= count;
      }
      target.Flush(true);
    }
    if (hash != null) hash.TransformFinalBlock(new byte[0], 0, 0);
  }

  private static void Extract(FileStream source, string basePath, string cache, long extractorOffset, long extractorLength,
    long licenseOffset, long licenseLength, long archiveOffset, long archiveLength, byte[] expectedHash, string digest) {
    string partial = cache + ".partial";
    string absoluteRoot = Path.GetFullPath(basePath).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
    if (!Path.GetFullPath(partial).StartsWith(absoluteRoot, StringComparison.OrdinalIgnoreCase)) throw new IOException("Unsafe cache path.");
    if (Directory.Exists(partial)) Directory.Delete(partial, true);
    Directory.CreateDirectory(partial);
    string extractor = Path.Combine(partial, "7za.exe"), archive = Path.Combine(partial, "bundle.7z");
    CopyPart(source, extractorOffset, extractorLength, extractor, null);
    CopyPart(source, licenseOffset, licenseLength, Path.Combine(partial, "7zip-LICENSE.txt"), null);
    using (SHA256 hash = SHA256.Create()) {
      CopyPart(source, archiveOffset, archiveLength, archive, hash);
      string actual = BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant();
      if (actual != digest) throw new InvalidDataException("Bundle checksum does not match.");
    }
    ProcessStartInfo unpack = new ProcessStartInfo(extractor);
    unpack.Arguments = "x -y -bd -o" + Quote(partial) + " " + Quote(archive);
    unpack.WorkingDirectory = partial;
    unpack.UseShellExecute = false;
    unpack.CreateNoWindow = true;
    using (Process child = Process.Start(unpack)) {
      if (child == null) throw new IOException("Bundled extractor could not start.");
      child.WaitForExit();
      if (child.ExitCode != 0) throw new IOException("Bundled extractor failed: " + child.ExitCode);
    }
    File.Delete(archive);
    if (!File.Exists(Path.Combine(partial, "Chuba Sprite Lab.exe"))) throw new IOException("Sprite Lab executable is missing from bundle.");
    File.WriteAllText(Path.Combine(partial, ".ready"), digest);
    if (Directory.Exists(cache)) {
      if (!Path.GetFullPath(cache).StartsWith(absoluteRoot, StringComparison.OrdinalIgnoreCase)) throw new IOException("Unsafe cache path.");
      Directory.Delete(cache, true);
    }
    Directory.Move(partial, cache);
  }

  private static string Quote(string argument) {
    return "\"" + argument.Replace("\"", "\\\"") + "\"";
  }

  private static string JoinArguments(string[] arguments) {
    StringBuilder result = new StringBuilder();
    foreach (string argument in arguments) {
      if (result.Length > 0) result.Append(' ');
      result.Append(Quote(argument));
    }
    return result.ToString();
  }
}
