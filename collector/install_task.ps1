<#
.SYNOPSIS
  在本机注册/删除「每 10 分钟采集一次上海迪士尼排队」的 Windows 计划任务。

.DESCRIPTION
  注册的任务名默认 DisneyQueueCollect，动作是运行 collector/run_live.ps1 -SyncMock：
  - 用 HTTP/3 绕过大陆网络对 queue-times.com 的 TCP 重置（需要 pip install aioquic）
  - 采集成功后同时刷新 miniprogram/mock/，微信开发者工具/网页预览随时看到最新数字
  - 失败不会破坏上一份 data/latest.json，日志在 data/collect.log

  为什么需要本机采集：小程序 wx.request 只能走 TCP 上的 HTTP/1.1-2，用不了 QUIC；如果你不想
  让数据经过 GitHub Actions，就在自己 24 小时开机的电脑/树莓派上跑这个任务，再把 data/latest.json
  同步到你能 HTTPS 访问的存储（对象存储/云开发静态托管）。零服务器成本的做法仍是 GitHub Actions。

.PARAMETER IntervalMinutes
  采集间隔，默认 10 分钟（queue-times 上游本身约 10 分钟更新一次，更快没有收益，也容易被限流）。

.PARAMETER Remove
  删除任务（不再采集）。

.PARAMETER RunNow
  注册后立即运行一次，验证链路。

.PARAMETER TaskName
  任务名，默认 DisneyQueueCollect。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File collector/install_task.ps1 -RunNow
  powershell -NoProfile -ExecutionPolicy Bypass -File collector/install_task.ps1 -Remove
#>
[CmdletBinding()]
param(
    [int]$IntervalMinutes = 10,
    [switch]$Remove,
    [switch]$RunNow,
    [string]$TaskName = 'DisneyQueueCollect'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $root 'collector\run_live.ps1'
if (-not (Test-Path $runner)) { throw "找不到 $runner" }

if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
    throw '当前系统没有 ScheduledTasks 模块（需要 Windows 8+/Server 2012+）'
}

if ($Remove) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "已删除计划任务 $TaskName"
    } else {
        Write-Host "计划任务 $TaskName 不存在，无需删除"
    }
    return
}

$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = (Get-Command powershell -ErrorAction SilentlyContinue).Source }
if (-not $pwsh) { throw '找不到 pwsh/powershell' }

$arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Transport auto -SyncMock' -f $runner
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Description '每 10 分钟采集上海迪士尼实时排队（HTTP/3），刷新小程序 mock' | Out-Null

Write-Host "已注册计划任务 $TaskName，每 $IntervalMinutes 分钟运行一次："
Write-Host "  运行脚本: $runner"
Write-Host "  日志:     $(Join-Path $root 'data\collect.log')"

if ($RunNow) {
    Write-Host '立即运行一次...'
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 6
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host ("上次运行结果 LastTaskResult={0}，下次运行 {1}" -f $info.LastTaskResult, $info.NextRunTime)
}
