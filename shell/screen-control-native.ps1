$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$inputJson = [Console]::In.ReadToEnd()
if ($inputJson.Length -gt 32768) { exit 1 }
$action = $inputJson | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class ScreenInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSE { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEY { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSE mouse; [FieldOffset(0)] public KEY key; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] data, int size);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  public static void Move(int x,int y) { SetProcessDPIAware(); POINT p; GetCursorPos(out p); for(int i=1;i<=18;i++){ if(!SetCursorPos(p.X+(x-p.X)*i/18,p.Y+(y-p.Y)*i/18)) throw new Exception(); Thread.Sleep(16); } }
  public static void Text(string text) { foreach(char ch in text) { var pair=new INPUT[2]; pair[0].type=pair[1].type=1; pair[0].data.key.scan=pair[1].data.key.scan=ch; pair[0].data.key.flags=4; pair[1].data.key.flags=6; if(SendInput(2,pair,Marshal.SizeOf(typeof(INPUT)))!=2) throw new Exception(); } }
  static void Mouse(uint flags,int data) { var input=new INPUT[1]; input[0].data.mouse.flags=flags; input[0].data.mouse.data=unchecked((uint)data); if(SendInput(1,input,Marshal.SizeOf(typeof(INPUT)))!=1) throw new Exception(); }
  public static void Button(string name,bool down) { uint flag=name=="right"?(down?8u:16u):name=="middle"?(down?32u:64u):(down?2u:4u); Mouse(flag,0); }
  public static void Key(byte code,bool down) { var input=new INPUT[1]; input[0].type=1; input[0].data.key.vk=code; input[0].data.key.flags=(down?0u:2u)|((code>=33&&code<=40)||code==45||code==46||code==91?1u:0u); if(SendInput(1,input,Marshal.SizeOf(typeof(INPUT)))!=1) throw new Exception(); }
  public static void Scroll(string direction,int amount) { Mouse(direction=="left"||direction=="right"?4096u:2048u,(direction=="down"||direction=="left"?-120:120)*amount); }
  public static void Release() { Button("left",false); Button("right",false); Button("middle",false); foreach(byte k in new byte[]{16,17,18,91}) Key(k,false); }
}
'@
$held = [Collections.Generic.List[byte]]::new()
try {
  if ($action.action -in @('move','click','drag','scroll')) { [ScreenInput]::Move($action.x,$action.y) }
  switch ($action.action) {
    'click' { for ($i=0;$i -lt $action.clickCount;$i++) { [ScreenInput]::Button($action.button,$true); [ScreenInput]::Button($action.button,$false); Start-Sleep -Milliseconds 60 } }
    'drag' { [ScreenInput]::Button('left',$true); try { [ScreenInput]::Move($action.toX,$action.toY) } finally { [ScreenInput]::Button('left',$false) } }
    'scroll' { [ScreenInput]::Scroll($action.direction,$action.amount) }
    'type' { [ScreenInput]::Text($action.text) }
    'key' {
      $keys = @{Control=17;Alt=18;Shift=16;Meta=91;Enter=13;Tab=9;Escape=27;Backspace=8;Delete=46;Insert=45;Space=32;Home=36;End=35;PageUp=33;PageDown=34;ArrowUp=38;ArrowDown=40;ArrowLeft=37;ArrowRight=39}
      foreach ($part in $action.key.Split('+')) {
        $code = if ($keys.ContainsKey($part)) { $keys[$part] } elseif ($part -match '^F(\d+)$') { 111 + [int]$Matches[1] } else { [int][char]$part.ToUpperInvariant() }
        [ScreenInput]::Key([byte]$code,$true); $held.Add([byte]$code)
      }
    }
    'release' { [ScreenInput]::Release() }
  }
} finally { for ($i=$held.Count-1;$i -ge 0;$i--) { [ScreenInput]::Key($held[$i],$false) } }
[Console]::Out.Write('{"ok":true}')
