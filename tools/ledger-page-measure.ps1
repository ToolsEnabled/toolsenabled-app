# LANE W53 -- WHAT THE LEDGER PAGE ACTUALLY PAINTS, AT THE PERSON'S OWN WIDTH.
#
# The owner: "in ledger i see your requests and thats really working good now.
# its just ugly." Ugly is not a measurement, so this makes one: it renders this
# repo's own dev server in headless Chrome over CDP, navigates to #/ledger, and
# prints the painted geometry of the page shell, the request rows and the
# build-queue section -- what is unused, what wraps, what is narrower than the
# text inside it. CSS source alone cannot answer that; only a layout engine can.
#
# Modelled on tools/page-width-measure.ps1 (lane W28), which measures the home
# and computers routes and hard-codes them. This is its ledger sibling rather
# than an edit to it, so W28's committed driver keeps saying exactly what its
# own report cites.
#
# NOTHING THIS STARTS MAY TOUCH THE RUNNING PRODUCT'S STATE. A process started
# through host.exec inherits TOOLSENABLED_STATE_ROOT and TOOLSENABLED_VAULT_PATH
# pointing at the live profile, and both vite and Chrome are started here, so
# both are redirected into a scratch directory under the Dev temp root, and
# Chrome is given its own --user-data-dir there too. The three paths are printed
# so a report can name them.
#
# Usage: powershell -File tools/ledger-page-measure.ps1 [-ViewportWidths 2560]
param(
  [int]$Port = 4629,
  [int]$DebugPort = 9334,
  [int[]]$ViewportWidths = @(2560),
  [int]$ViewportHeight = 1048
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$devTemp = 'C:\Users\ToolsEnabled-Dev\AppData\Local\Temp'
$scratch = Join-Path $devTemp ("w53-ledger-measure-" + $PID)
$scratchState = Join-Path $scratch 'state'
$scratchVault = Join-Path $scratchState 'vault\secrets.json'
$scratchChrome = Join-Path $scratch 'chrome'
if (-not $scratch.StartsWith('C:\Users\ToolsEnabled-Dev\')) { Write-Output 'SCRATCH_OUTSIDE_DEV_PROFILE'; exit 1 }
Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $scratchState, $scratchChrome | Out-Null
$env:TOOLSENABLED_STATE_ROOT = $scratchState
$env:TOOLSENABLED_VAULT_PATH = $scratchVault
Write-Output "SCRATCH_STATE_ROOT=$scratchState"
Write-Output "SCRATCH_VAULT_PATH=$scratchVault"
Write-Output "SCRATCH_CHROME_PROFILE=$scratchChrome"

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

$vite = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "npx vite --host 127.0.0.1 --port $Port --strictPort > ledger-page-measure-vite.log 2>&1" -WorkingDirectory $root -PassThru -WindowStyle Hidden
$chrome = $null
try {
  if (-not (Wait-Port $Port 40)) { Write-Output 'VITE_FAILED_TO_START'; exit 1 }

  $chromeArgs = @('--headless=new', '--disable-gpu', "--remote-debugging-port=$DebugPort", "--user-data-dir=$scratchChrome", "--window-size=$($ViewportWidths[0]),$ViewportHeight", 'about:blank')
  $chrome = Start-Process -FilePath $chromePath -ArgumentList $chromeArgs -PassThru -WindowStyle Hidden
  if (-not (Wait-Port $DebugPort 25)) { Write-Output 'CHROMIUM_FAILED_TO_START'; exit 1 }
  Start-Sleep -Seconds 1

  $newTab = Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:$DebugPort/json/new?http://localhost:$Port/#/ledger"
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
  function Receive-Cdp($expectId, $timeoutSec = 20) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    $buffer = New-Object byte[] 262144
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

  # ORDER MATTERS, AND THE FIRST ATTEMPT GOT IT WRONG. Setting the hash before
  # the app has booted does nothing: the router reads the hash once at start,
  # and the measurement came back with route=home and zero rows, which reads
  # exactly like "the ledger has no rows" rather than "the page was never
  # opened". So: wait for the app to exist, THEN ask for the route, THEN wait
  # for the route to be the one asked for. A measurement of a page that was
  # never opened is not a measurement.
  $appUp = $false
  for ($i = 0; $i -lt 60; $i++) {
    if ((Eval-Js "document.body && document.body.getAttribute('data-route') ? 'yes' : 'no'") -eq 'yes') { $appUp = $true; break }
    Start-Sleep -Milliseconds 500
  }
  Write-Output "APP_BOOTED=$appUp"
  Eval-Js "location.hash = '#/ledger'" | Out-Null
  $booted = $false
  for ($i = 0; $i -lt 60; $i++) {
    if ((Eval-Js "document.body.getAttribute('data-route') === 'ledger' ? 'yes' : 'no'") -eq 'yes') { $booted = $true; break }
    Start-Sleep -Milliseconds 500
  }
  Write-Output "LEDGER_ROUTE_REACHED=$booted"
  if ($booted) { Start-Sleep -Milliseconds 1500 }
  Write-Output ("ROUTE=" + (Eval-Js "document.body.getAttribute('data-route')"))

  $measureExpr = @'
JSON.stringify((function(){
  function box(el){ if(!el) return null; var r = el.getBoundingClientRect(); var cs = getComputedStyle(el);
    return { cls: (el.className||'').toString().slice(0,70), x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height),
             clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
             maxWidth: cs.maxWidth, display: cs.display, gridCols: cs.gridTemplateColumns, whiteSpace: cs.whiteSpace, overflowX: cs.overflowX }; }
  var shell = document.querySelector('.ledger') || document.querySelector('[data-route-view="ledger"]') || document.querySelector('main');
  var rows = Array.prototype.slice.call(document.querySelectorAll('.ledger-row, [data-ledger-row], tbody tr')).slice(0, 6);
  var wide = rows.filter(function(r){ return r.scrollWidth > r.clientWidth + 1; }).length;
  var tall = rows.filter(function(r){ return r.scrollHeight > r.clientHeight + 1; }).length;
  return {
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    route: document.body.getAttribute('data-route'),
    pageMax: getComputedStyle(document.body).getPropertyValue('--page-max').trim(),
    shell: box(shell),
    unusedLeft: shell ? Math.round(shell.getBoundingClientRect().x) : null,
    unusedRight: shell ? Math.round(window.innerWidth - (shell.getBoundingClientRect().x + shell.getBoundingClientRect().width)) : null,
    rowCount: document.querySelectorAll('.ledger-row, [data-ledger-row], tbody tr').length,
    rowsClippedSideways: wide, rowsClippedDown: tall,
    rows: rows.map(function(r){ var b = box(r); b.text = (r.textContent||'').replace(/\s+/g,' ').trim().slice(0,90); b.cells = Array.prototype.slice.call(r.children).map(function(c){ var cb = box(c); cb.text = (c.textContent||'').replace(/\s+/g,' ').trim().slice(0,40); return cb; }); return b; })
  };
})())
'@

  foreach ($vw in $ViewportWidths) {
    Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = $vw; height = $ViewportHeight; deviceScaleFactor = 1; mobile = $false } | Out-Null
    Start-Sleep -Milliseconds 600
    Write-Output "=== LEDGER viewport=$vw ==="
    Write-Output (Eval-Js $measureExpr)
  }
} finally {
  if ($chrome) { Stop-Process -Id $chrome.Id -Force -ErrorAction SilentlyContinue }
  if ($vite) { Stop-Process -Id $vite.Id -Force -ErrorAction SilentlyContinue }
  Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.StartTime -gt (Get-Date).AddMinutes(-10) -and $_.CommandLine -like "*--port $Port*" } | Stop-Process -Force -ErrorAction SilentlyContinue
}
