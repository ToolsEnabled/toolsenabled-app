# Renders the app's own dev server in headless Chrome over CDP and prints the
# real, painted box widths for the home (page 1) and computers (page 2)
# routes at one or more viewport widths. This is the rendered measurement
# lane W28's report cites -- CSS source alone cannot tell you what a min()
# or a two-column grid actually paints, only Chrome's own layout engine can.
#
# No jsdom/puppeteer/playwright package is vendored in this repo's
# node_modules, and the ToolsEnabled browser tool at this permission level
# refuses a plain http:// dev-server URL, so this drives a throwaway headless
# Chrome directly over the Chrome DevTools Protocol with nothing but
# Windows PowerShell and the Chrome binary already on the machine.
#
# Usage: powershell -File tools/page-width-measure.ps1 [-Port 4628] [-DebugPort 9333] [-ViewportWidths 2560,1920]
param(
  [int]$Port = 4628,
  [int]$DebugPort = 9333,
  [int[]]$ViewportWidths = @(2560, 1920),
  [int]$ViewportHeight = 1080
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$chromeCandidates = @(
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
)
$chromePath = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chromePath) { Write-Output 'NO_CHROMIUM_BROWSER_FOUND'; exit 1 }

function Wait-Port($p, $timeoutSec = 30) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $client = New-Object System.Net.Sockets.TcpClient
      $client.Connect('127.0.0.1', $p)
      $client.Close()
      return $true
    } catch { Start-Sleep -Milliseconds 300 }
  }
  return $false
}

$vite = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "npx vite --host 127.0.0.1 --port $Port --strictPort > page-width-measure-vite.log 2>&1" -WorkingDirectory $root -PassThru -WindowStyle Hidden
$chrome = $null
try {
  if (-not (Wait-Port $Port 30)) { Write-Output 'VITE_FAILED_TO_START'; exit 1 }

  $chromeArgs = @('--headless=new', '--disable-gpu', "--remote-debugging-port=$DebugPort", "--window-size=$($ViewportWidths[0]),$ViewportHeight", 'about:blank')
  $chrome = Start-Process -FilePath $chromePath -ArgumentList $chromeArgs -PassThru -WindowStyle Hidden
  if (-not (Wait-Port $DebugPort 20)) { Write-Output 'CHROMIUM_FAILED_TO_START'; exit 1 }
  Start-Sleep -Seconds 1

  $newTab = Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:$DebugPort/json/new?http://localhost:$Port/"
  $wsUrl = $newTab.webSocketDebuggerUrl

  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ws.ConnectAsync([Uri]$wsUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null

  $msgId = 0
  function Send-Cdp($method, $params) {
    $script:msgId += 1
    $obj = @{ id = $script:msgId; method = $method }
    if ($params) { $obj.params = $params }
    $json = $obj | ConvertTo-Json -Depth 10 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $seg = New-Object ArraySegment[byte] (,$bytes)
    $ws.SendAsync($seg, [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
    return $script:msgId
  }
  function Receive-Cdp($expectId, $timeoutSec = 15) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    $buffer = New-Object byte[] 65536
    while ((Get-Date) -lt $deadline) {
      $seg = New-Object ArraySegment[byte] (,$buffer)
      $result = $ws.ReceiveAsync($seg, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
      $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
      $parsed = $text | ConvertFrom-Json
      if ($parsed.id -eq $expectId) { return $parsed }
    }
    throw "timed out waiting for CDP response id=$expectId"
  }
  function Eval-Js($expression) {
    $id = Send-Cdp 'Runtime.evaluate' @{ expression = $expression; returnByValue = $true; awaitPromise = $false }
    $resp = Receive-Cdp $id
    return $resp.result.result.value
  }

  Send-Cdp 'Page.enable' $null | Out-Null
  Send-Cdp 'Runtime.enable' $null | Out-Null

  $booted = $false
  for ($i = 0; $i -lt 30; $i++) {
    if ((Eval-Js "document.querySelector('.home') ? 'yes' : 'no'") -eq 'yes') { $booted = $true; break }
    Start-Sleep -Milliseconds 500
  }
  Write-Output "HOME_BOOTED=$booted"

  $homeExpr = @'
JSON.stringify((function(){
  var el = document.querySelector('.home');
  if (!el) return null;
  var r = el.getBoundingClientRect();
  return { innerWidth: window.innerWidth, left: r.left, right: r.right, width: r.width, maxWidth: getComputedStyle(el).maxWidth };
})())
'@
  foreach ($vw in $ViewportWidths) {
    Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = $vw; height = $ViewportHeight; deviceScaleFactor = 1; mobile = $false } | Out-Null
    Start-Sleep -Milliseconds 400
    Write-Output "=== HOME viewport=$vw ==="
    Write-Output (Eval-Js $homeExpr)
  }

  Eval-Js "location.hash = '#/computers'; 'ok'" | Out-Null
  Start-Sleep -Milliseconds 800
  $booted2 = $false
  for ($i = 0; $i -lt 30; $i++) {
    if ((Eval-Js "document.querySelector('.computers') ? 'yes' : 'no'") -eq 'yes') { $booted2 = $true; break }
    Start-Sleep -Milliseconds 500
  }
  Write-Output "COMPUTERS_BOOTED=$booted2"

  $computersExpr = @'
JSON.stringify((function(){
  var el = document.querySelector('.computers');
  if (!el) return null;
  var r = el.getBoundingClientRect();
  var canvasEl = document.querySelector('.computer-tree-canvas') || document.querySelector('.graph-pane') || document.querySelector('.comp-body');
  var canvas = canvasEl ? (function(){ var cr = canvasEl.getBoundingClientRect(); return { left: cr.left, right: cr.right, width: cr.width }; })() : null;
  return { innerWidth: window.innerWidth, left: r.left, right: r.right, width: r.width, canvas: canvas };
})())
'@
  foreach ($vw in $ViewportWidths) {
    Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = $vw; height = $ViewportHeight; deviceScaleFactor = 1; mobile = $false } | Out-Null
    Start-Sleep -Milliseconds 400
    Write-Output "=== COMPUTERS viewport=$vw ==="
    Write-Output (Eval-Js $computersExpr)
  }

  $ws.CloseAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'done', [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
} finally {
  if ($chrome) { Stop-Process -Id $chrome.Id -Force -ErrorAction SilentlyContinue }
  if ($vite) { Stop-Process -Id $vite.Id -Force -ErrorAction SilentlyContinue }
  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -eq $Port -or $_.LocalPort -eq $DebugPort } |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
