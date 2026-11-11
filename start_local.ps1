<#
自己用（不上架）的一键启动脚本：
  1) 用 HTTP/3 抓一次实时排队数据（TCP 被重置会自动回退）；
  2) 后台每 N 分钟自动刷新（关闭本窗口即停止，想常驻用 collector\install_task.ps1）；
  3) 起本地静态服务器，手机连同一个 Wi-Fi 就能打开网页版。

用法：
  powershell -NoProfile -ExecutionPolicy Bypass -File start_local.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File start_local.ps1 -Port 8123 -IntervalMinutes 10
#>
param(
  [int]$Port = 8123,
  [int]$IntervalMinutes = 10,
  [string]$Python = ""
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Resolve-Python {
  param([string]$Hint)
  $cands = @()
  if ($Hint) { $cands += $Hint }
  $cands += @(
    "C:\Users\翁\AppData\Local\Programs\Python\Python312\python.exe",
    "python",
    "python3"
  )
  foreach ($c in $cands) {
    try {
      $exe = $c
      if ($c -notmatch '\\') {
        $found = Get-Command $c -ErrorAction Stop
        $exe = $found.Source
      }
      $null = & $exe -c "import aioquic" 2>$null
      if ($LASTEXITCODE -eq 0) { return $exe }
    } catch {
      # 继续试下一个
    }
  }
  throw "没有找到装了 aioquic 的 Python。请先执行： python -m pip install aioquic"
}

function Get-LanIp {
  try {
    $ips = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
      Where-Object { $_.AddressFamily -eq 'InterNetwork' -and $_.ToString() -notmatch '^127\.' }
    if ($ips -and $ips.Count -gt 0) { return $ips[0].ToString() }
  } catch { }
  foreach ($ip in @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue)) {
    if ($ip.IPAddress -notmatch '^(127\.|169\.254\.)' -and $ip.IPAddress -notmatch '^100\.') {
      return $ip.IPAddress
    }
  }
  return $null
}

$python = Resolve-Python -Hint $Python
Write-Host "使用 Python: $python"

Write-Host "[1/3] 抓一次实时数据（TCP 失败会自动回退 HTTP/3）..."
& $python "collector\collect.py" --transport auto
if ($LASTEXITCODE -ne 0) {
  Write-Host "    这次抓取失败，先继续用上一份数据（详情看 data\latest.error.json）。"
}

Write-Host "[2/3] 后台每 $IntervalMinutes 分钟自动刷新（关闭本窗口即停止）..."
$collectorJob = Start-Job -ScriptBlock {
  param($exe, $dir, $mins)
  Set-Location $dir
  while ($true) {
    Start-Sleep -Seconds ($mins * 60)
    try {
      & $exe "collector\collect.py" --transport auto *>> "$dir\data\collect.log"
    } catch { }
  }
} -ArgumentList $python, $root, $IntervalMinutes

$lan = Get-LanIp
Write-Host "[3/3] 本地服务器已启动，按 Ctrl+C 停止"
Write-Host ""
Write-Host "  电脑上打开:   http://127.0.0.1:$Port/web-preview/index.html"
if ($lan) {
  Write-Host "  手机上打开:   http://$lan`:$Port/web-preview/index.html"
  Write-Host "                （手机和电脑连同一个 Wi-Fi；首次手机打不开时，在 Windows 防火墙弹窗里允许 Python 访问「专用网络」）"
}
Write-Host "  分时预测报告: http://127.0.0.1:$Port/docs/forecast-report.html"
Write-Host ""
Write-Host "  提示：这个页面的数据来自本机采集，电脑关机后手机就打不开了。"
Write-Host "        想让电脑关了也能用，需要上架（备案 + 公网 HTTPS），可以随时找我要步骤。"
Write-Host ""

try {
  & $python -m http.server $Port --bind 0.0.0.0 --directory $root
} finally {
  Stop-Job $collectorJob -ErrorAction SilentlyContinue
  Remove-Job $collectorJob -Force -ErrorAction SilentlyContinue
}
