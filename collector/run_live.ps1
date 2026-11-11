<#
.SYNOPSIS
  跑一次上海迪士尼实时排队采集（大陆网络自动走 HTTP/3），供 Windows 计划任务调用。

.DESCRIPTION
  - 调用 collector/collect.py --transport auto：先试普通 HTTPS/TCP，被重置就回退 QUIC/UDP 443。
  - 失败时不覆盖上一份 data/latest.json（collect.py 自己保证），错误写 data/latest.error.json。
  - 输出追加到 data/collect.log（超过 1MB 自动滚成 collect.log.1）。
  - -SyncMock：把 data/ 刷新到小程序离线 mock（小程序/预览不需要网络也能看到最新数字）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File collector/run_live.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File collector/run_live.ps1 -SyncMock
#>
[CmdletBinding()]
param(
    [string]$Python = '',
    [ValidateSet('auto', 'tcp', 'h3')]
    [string]$Transport = 'auto',
    [switch]$SyncMock,
    [string]$Log = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Log) { $Log = Join-Path $root 'data\collect.log' }

function Write-Log([string]$Text) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text
    Write-Host $line
    if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt 1MB)) {
        Move-Item $Log "$Log.1" -Force
    }
    Add-Content -Path $Log -Value $line -Encoding utf8
}

function Resolve-PythonExe {
    if ($Python) {
        if (-not (Test-Path $Python)) { throw "指定的 Python 不存在: $Python" }
        return $Python
    }
    foreach ($candidate in @('python', 'python3')) {
        $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) { return $py.Source + ' -3' }
    throw '找不到 Python，请用 -Python 指定解释器路径'
}

$pythonExe = Resolve-PythonExe
$collector = Join-Path $root 'collector\collect.py'
if (-not (Test-Path $collector)) { throw "找不到 $collector" }

$env:PYTHONIOENCODING = 'utf-8'
Write-Log ("开始采集（transport=$Transport，python=$pythonExe）")

$cmdLine = "`"$pythonExe`" `"$collector`" --transport $Transport"
# Windows PowerShell 5.1 用系统 ANSI 码页（GBK）解码原生命令输出，而 python 输出 UTF-8；
# 不切 OutputEncoding 会把中文日志写成乱码。
$previousOutputEncoding = [Console]::OutputEncoding
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $output = cmd /c "$cmdLine 2>&1"
    $exitCode = $LASTEXITCODE
} finally {
    [Console]::OutputEncoding = $previousOutputEncoding
}
foreach ($line in $output) { Write-Log $line }

if ($exitCode -ne 0) {
    Write-Log "采集失败（exit=$exitCode），latest.json 保持上一份可用数据"
    exit $exitCode
}

if ($SyncMock) {
    $mockDir = Join-Path $root 'miniprogram\mock'
    New-Item -ItemType Directory -Path $mockDir -Force | Out-Null
    foreach ($name in @('catalog.json', 'latest.json', 'forecast.json')) {
        Copy-Item (Join-Path $root "data\$name") (Join-Path $mockDir $name) -Force
    }
    Write-Log '已同步 data/ -> miniprogram/mock/'
}

$latest = Join-Path $root 'data\latest.json'
if (Test-Path $latest) {
    try {
        $doc = Get-Content $latest -Raw -Encoding utf8 | ConvertFrom-Json
        $open = @($doc.waits | Where-Object { $_.status -eq 'operating' }).Count
        Write-Log ("完成：source={0} fetchedAt={1} 项目={2} 开放={3}" -f $doc.source, $doc.fetchedAt, @($doc.waits).Count, $open)
    } catch {
        Write-Log "读取 latest.json 摘要失败: $_"
    }
}
exit 0
