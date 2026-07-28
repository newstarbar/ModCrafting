# 修复 Windows Defender 拦截 jlink 的脚本（需要管理员权限）
# 用法：右键 -> 以管理员身份运行，或在管理员 PowerShell 中执行：
#   powershell -ExecutionPolicy Bypass -File scripts\toolchain\fix-defender-exclusion.ps1
#
# 作用：将 java.exe/jlink.exe 和项目 resources 目录添加到 Defender 排除列表，
#       然后重新运行 jlink 构建精简 JRE（~60MB，比 fallback 的 185MB 小 3 倍）

$ErrorActionPreference = 'Stop'

# 定位项目根目录（脚本在 scripts/toolchain/ 下）
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent $scriptDir)
Set-Location $root

Write-Host '=== 项目根目录: '$root ==='

# 检查管理员权限
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host '错误：需要管理员权限运行此脚本' -ForegroundColor Red
    Write-Host '请右键 PowerShell -> 以管理员身份运行，然后执行：'
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit 1
}

Write-Host '=== 添加 Windows Defender 排除项 ==='
try {
    $javaExe = Join-Path $root 'resources\jdk-21\bin\java.exe'
    $jlinkExe = Join-Path $root 'resources\jdk-21\bin\jlink.exe'
    $resourcesDir = Join-Path $root 'resources'

    Add-MpPreference -ExclusionProcess $javaExe -ErrorAction Stop
    Write-Host "  排除进程: $javaExe"
    Add-MpPreference -ExclusionProcess $jlinkExe -ErrorAction Stop
    Write-Host "  排除进程: $jlinkExe"
    Add-MpPreference -ExclusionPath $resourcesDir -ErrorAction Stop
    Write-Host "  排除路径: $resourcesDir"
    Write-Host 'Defender 排除项添加成功' -ForegroundColor Green
} catch {
    Write-Host "添加排除项失败: $_" -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '=== 重新运行 jlink 构建精简 JRE ==='
$testDir = Join-Path $root 'resources\jre-21-minimal'
if (Test-Path $testDir) {
    Write-Host "清理旧 JRE: $testDir"
    Remove-Item -Recurse -Force $testDir
}

$jlinkExe = Join-Path $root 'resources\jdk-21\bin\jlink.exe'
$jmodsDir = Join-Path $root 'resources\jdk-21\jmods'
$modules = 'java.base,java.compiler,java.datatransfer,java.desktop,java.instrument,java.logging,java.management,java.naming,java.net.http,java.prefs,java.scripting,java.se,java.security.jgss,java.security.sasl,java.sql,java.sql.rowset,java.transaction.xa,java.xml,java.xml.crypto,jdk.crypto.cryptoki,jdk.crypto.ec,jdk.jfr,jdk.jshell,jdk.management,jdk.net,jdk.nio.mapmode,jdk.unsupported,jdk.zipfs'

& $jlinkExe --module-path $jmodsDir --add-modules $modules --output $testDir --strip-debug --no-header-files --no-man-pages --compress=1 2>&1

Write-Host "jlink 退出码: $LASTEXITCODE"

if (Test-Path (Join-Path $testDir 'bin\java.exe')) {
    Write-Host ''
    Write-Host '=== JRE 构建成功 ===' -ForegroundColor Green
    & (Join-Path $testDir 'bin\java.exe') -version 2>&1

    $size = [math]::Round((Get-ChildItem -Recurse $testDir | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
    Write-Host "JRE 体积: $size MB（比 fallback 的 185MB 小约 3 倍）"
} else {
    Write-Host 'JRE 构建失败' -ForegroundColor Red
}

Write-Host ''
Write-Host '按任意键退出...'
$null = Read-Host
