# The deck's hands on Windows: keys, clipboard, windows, media and volume.
#
# One long-lived process fed JSON lines on stdin, one JSON line back per
# request. Starting PowerShell costs ~150 ms and Add-Type compiling the C# below
# costs more, so paying that once at bridge start is what keeps a tap under the
# 300 ms the plan set. Must run with -STA: the clipboard refuses anything else.

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class DeckNative {
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  delegate bool EnumProc(IntPtr h, IntPtr l);

  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr r1; public IntPtr peb; public IntPtr r2a; public IntPtr r2b; public IntPtr pid; public IntPtr parent; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI info, int len, out int ret);

  const uint KEYUP = 0x0002;

  public static void Keys(ushort[] vks) {
    // Chord: every key down in order, then up in reverse. Ctrl+Shift+M is
    // three downs and three ups, which is how a person presses it.
    var list = new INPUT[vks.Length * 2];
    for (int i = 0; i < vks.Length; i++) list[i] = Key(vks[i], false);
    for (int i = 0; i < vks.Length; i++) list[vks.Length + i] = Key(vks[vks.Length - 1 - i], true);
    SendInput((uint)list.Length, list, Marshal.SizeOf(typeof(INPUT)));
  }

  static INPUT Key(ushort vk, bool up) {
    var k = new INPUT { type = 1 };
    k.u.ki = new KEYBDINPUT { wVk = vk, dwFlags = up ? KEYUP : 0 };
    return k;
  }

  public static int ParentOf(int pid) {
    try {
      using (var p = Process.GetProcessById(pid)) {
        var info = new PBI(); int ret;
        if (NtQueryInformationProcess(p.Handle, 0, ref info, Marshal.SizeOf(info), out ret) != 0) return 0;
        return info.parent.ToInt32();
      }
    } catch { return 0; }
  }

  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);

  // A visible, titled, top-level window the process owns. One Cursor process
  // owns every Cursor window, so when there are several the one whose title
  // names the session's folder wins ("... - my-app - Cursor").
  public static IntPtr WindowOf(int pid, string hint) {
    IntPtr first = IntPtr.Zero, match = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner != pid || !IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
      int n = GetWindowTextLength(h);
      if (n == 0) return true;
      if (first == IntPtr.Zero) first = h;
      if (!string.IsNullOrEmpty(hint)) {
        var sb = new System.Text.StringBuilder(n + 1); GetWindowText(h, sb, n + 1);
        if (sb.ToString().IndexOf(hint, StringComparison.OrdinalIgnoreCase) >= 0) { match = h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return match != IntPtr.Zero ? match : first;
  }

  // Walk up from a process until an ancestor owns a window. A Claude session is
  // claude -> shell -> Windows Terminal, or claude -> the editor's extension
  // host -> Cursor. Eight hops is further than either goes.
  public static IntPtr WindowForTree(int pid, string hint) {
    int cur = pid;
    for (int i = 0; i < 8 && cur > 4; i++) {
      var h = WindowOf(cur, hint);
      if (h != IntPtr.Zero) return h;
      cur = ParentOf(cur);
    }
    return IntPtr.Zero;
  }

  // Windows refuses SetForegroundWindow to a process that did not receive the
  // last input. A synthetic Alt tap counts as input, which is the documented
  // way round it without turning the lock off system-wide.
  public static bool Focus(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    if (IsIconic(h)) ShowWindow(h, 9);
    Keys(new ushort[] { 0x12 });
    SetForegroundWindow(h);
    Thread.Sleep(60);
    return GetForegroundWindow() == h;
  }

  public static bool FocusPid(int pid, string hint) { return Focus(WindowForTree(pid, hint)); }

  // The window a paste would land in right now: its process and title.
  public static string[] Foreground() {
    var h = GetForegroundWindow();
    if (h == IntPtr.Zero) return new string[] { "", "" };
    uint pid; GetWindowThreadProcessId(h, out pid);
    string name = "";
    try { using (var p = Process.GetProcessById((int)pid)) name = p.ProcessName.ToLowerInvariant(); } catch { }
    int n = GetWindowTextLength(h);
    var sb = new System.Text.StringBuilder(n + 1); GetWindowText(h, sb, n + 1);
    return new string[] { name, sb.ToString() };
  }
}

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f1(); int f2(); int f3(); int f4();
  int SetMasterVolumeLevelScalar(float level, Guid ctx);
  int f5();
  int GetMasterVolumeLevelScalar(out float level);
  int f6(); int f7(); int f8(); int f9();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f1(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

public static class DeckAudio {
  static IAudioEndpointVolume Endpoint() {
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice dev; Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
    var iid = typeof(IAudioEndpointVolume).GUID; object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }
  public static int Get() { float v; Endpoint().GetMasterVolumeLevelScalar(out v); return (int)Math.Round(v * 100); }
  public static void Set(int pct) { Endpoint().SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, pct)) / 100f, Guid.Empty); }
  public static bool Muted() { bool m; Endpoint().GetMute(out m); return m; }
  public static void Mute(bool m) { Endpoint().SetMute(m, Guid.Empty); }
}
'@

# ------------------------------------------------------------------ media
# Windows' own now-playing list: Spotify and a browser playing YouTube both
# report to it, which is what lets one set of controls drive either.
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
  Select-Object -First 1
function Await($op, [Type]$type) {
  $t = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $t.Wait(3000)) { throw 'media call timed out' }
  $t.Result
}
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
# PowerShell 5.1 cannot see the stream's interface members, so overload
# resolution on AsStreamForRead fails. Invoking the method by reflection lets
# the runtime do the interface cast that PowerShell will not.
$script:asStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))
$script:mgr = $null
function Manager {
  if (-not $script:mgr) {
    $script:mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  }
  $script:mgr
}

# Artwork is 30-200 KB, so it never rides along with the status poll. Media-List
# hands back an id; the bridge fetches the bytes once per track with 'art'.
$script:artCache = @{}
function Art-Id($props, [string]$key) {
  $id = ([BitConverter]::ToString([Security.Cryptography.MD5]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($key)))).Replace('-', '').Substring(0, 16)
  if ($script:artCache.ContainsKey($id)) { return $(if ($script:artCache[$id]) { $id } else { $null }) }
  $b64 = $null
  try {
    if ($props.Thumbnail) {
      $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
      $net = $script:asStream.Invoke($null, @($stream))
      $ms = New-Object System.IO.MemoryStream
      $net.CopyTo($ms)
      $net.Dispose()
      if ($ms.Length -gt 0) { $b64 = [Convert]::ToBase64String($ms.ToArray()) }
    }
  } catch { $b64 = $null }
  if ($script:artCache.Count -gt 30) { $script:artCache.Clear() }
  $script:artCache[$id] = $b64
  $(if ($b64) { $id } else { $null })
}

function Media-List {
  $out = @()
  foreach ($s in (Manager).GetSessions()) {
    try {
      $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $tl = $s.GetTimelineProperties()
      $key = "$($s.SourceAppUserModelId)|$($p.Title)|$($p.Artist)"
      $out += [ordered]@{
        app       = $s.SourceAppUserModelId
        title     = $p.Title
        artist    = $p.Artist
        album     = $p.AlbumTitle
        status    = [string]$s.GetPlaybackInfo().PlaybackStatus
        position  = [int]$tl.Position.TotalSeconds
        duration  = [int]$tl.EndTime.TotalSeconds
        updatedAt = $tl.LastUpdatedTime.ToUnixTimeMilliseconds()
        art       = (Art-Id $p $key)
      }
    } catch { }
  }
  , $out
}

function Media-Cmd($app, $cmd) {
  $target = $null
  foreach ($s in (Manager).GetSessions()) { if (-not $app -or $s.SourceAppUserModelId -eq $app) { $target = $s; break } }
  if (-not $target) { $target = (Manager).GetCurrentSession() }
  if (-not $target) { throw 'nothing is playing' }
  $op = switch ($cmd) {
    'toggle' { $target.TryTogglePlayPauseAsync() }
    'next'   { $target.TrySkipNextAsync() }
    'prev'   { $target.TrySkipPreviousAsync() }
    default  { throw "unknown media command $cmd" }
  }
  Await $op ([bool])
}

# ------------------------------------------------------------------ typing
function Paste([string]$text, [bool]$enter) {
  # Paste rather than type: one Ctrl+V lands a 200-word prompt at once and
  # keeps every character intact. Your own clipboard goes back afterwards.
  $old = $null
  try { if ([Windows.Forms.Clipboard]::ContainsText()) { $old = [Windows.Forms.Clipboard]::GetText() } } catch { }
  [Windows.Forms.Clipboard]::SetText($text)
  [DeckNative]::Keys([uint16[]]@(0x11, 0x56))
  if ($enter) { Start-Sleep -Milliseconds 120; [DeckNative]::Keys([uint16[]]@(0x0D)) }
  Start-Sleep -Milliseconds 250
  try { if ($null -ne $old) { [Windows.Forms.Clipboard]::SetText($old) } else { [Windows.Forms.Clipboard]::Clear() } } catch { }
}

function Running {
  , @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.ProcessName.ToLower() } | Sort-Object -Unique)
}

function Focus-App([string]$proc) {
  $p = Get-Process -Name $proc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { return $false }
  [DeckNative]::Focus($p.MainWindowHandle)
}

function Launch([string]$target) {
  if ($target -match '^shell:') { Start-Process explorer.exe $target } else { Start-Process $target }
}

# ------------------------------------------------------------------ loop
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $result = switch ($req.op) {
      'ping'      { 'pong' }
      'keys'      { [DeckNative]::Keys([uint16[]]$req.vks); $true }
      'paste'     { Paste $req.text ([bool]$req.enter); $true }
      'focusPid'  { [DeckNative]::FocusPid([int]$req.pid, [string]$req.hint) }
      'focusApp'  { Focus-App $req.proc }
      'foreground' { $f = [DeckNative]::Foreground(); [ordered]@{ proc = $f[0]; title = $f[1] } }
      'launch'    { Launch $req.target; $true }
      'running'   { Running }
      'media'     { Media-List }
      'mediaCmd'  { Media-Cmd $req.app $req.cmd }
      'art'       { $script:artCache[[string]$req.art] }
      'clipboard' { if ([Windows.Forms.Clipboard]::ContainsText()) { [Windows.Forms.Clipboard]::GetText() } else { '' } }
      'volume'    { [ordered]@{ level = [DeckAudio]::Get(); muted = [DeckAudio]::Muted() } }
      'setVolume' { [DeckAudio]::Set([int]$req.level); [DeckAudio]::Mute($false); $true }
      'setMute'   { [DeckAudio]::Mute([bool]$req.muted); $true }
      default     { throw "unknown op $($req.op)" }
    }
    $out = @{ id = $id; ok = $true; result = $result }
  } catch {
    $out = @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
