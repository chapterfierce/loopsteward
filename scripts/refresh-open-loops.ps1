$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root 'dist\src\loops\cli.js'
$node = (Get-Command node -ErrorAction Stop).Source
$dataRoot = if ($env:LOOPSTEWARD_DATA) {
    $env:LOOPSTEWARD_DATA
} elseif (Test-Path -LiteralPath (Join-Path $root 'src\loops')) {
    Join-Path $root 'data'
} elseif ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA 'LoopSteward'
} else {
    Join-Path $env:USERPROFILE 'AppData\Local\LoopSteward'
}
$logDir = Join-Path $dataRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ('refresh-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { $npm = (Get-Command npm -ErrorAction Stop).Source }

Push-Location $root
try {
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] refresh start" |
        Out-File -FilePath $log -Append -Encoding utf8
    $sourceDir = Join-Path $root 'src'
    $needsBuild = -not (Test-Path -LiteralPath $cli)
    if (-not $needsBuild -and (Test-Path -LiteralPath $sourceDir)) {
        $cliTime = (Get-Item -LiteralPath $cli).LastWriteTimeUtc
        $newer = Get-ChildItem -LiteralPath $sourceDir -Filter '*.ts' -Recurse -File |
            Where-Object { $_.LastWriteTimeUtc -gt $cliTime } |
            Select-Object -First 1
        if ($newer) {
            $needsBuild = $true
        }
    }
    if ($needsBuild) {
        "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] build start (cli missing or sources newer)" |
            Out-File -FilePath $log -Append -Encoding utf8
        $buildOutput = & $npm run build:open-loops 2>&1 | Out-String
        $buildOutput | Out-File -FilePath $log -Append -Encoding utf8
        Write-Output $buildOutput
        if ($LASTEXITCODE -ne 0) {
            throw "npm run build:open-loops exited with code $LASTEXITCODE"
        }
    }
    else {
        "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] build skipped (sources unchanged)" |
            Out-File -FilePath $log -Append -Encoding utf8
    }
    $output = & $node $cli ingest --days 7 --limit 120 --concurrency 4 2>&1 | Out-String
    $output | Out-File -FilePath $log -Append -Encoding utf8
    Write-Output $output
    if ($LASTEXITCODE -ne 0) {
        throw "ingest exited with code $LASTEXITCODE"
    }
    $reconcileStamp = Join-Path $logDir ('reconcile-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
    if (-not (Test-Path -LiteralPath $reconcileStamp)) {
        "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] reconcile start" |
            Out-File -FilePath $log -Append -Encoding utf8
        $reconcileOutput = & $node $cli reconcile --days 7 --limit 120 --concurrency 4 --json 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) {
            $reconcileOutput | Out-File -FilePath $reconcileStamp -Encoding utf8
            "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] reconcile done" |
                Out-File -FilePath $log -Append -Encoding utf8
        }
        else {
            $reconcileOutput | Out-File -FilePath $log -Append -Encoding utf8
            "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] reconcile failed: exit $LASTEXITCODE" |
                Out-File -FilePath $log -Append -Encoding utf8
        }
    }
    $backup = Join-Path $dataRoot ('archive\loops-' + (Get-Date -Format 'yyyyMMdd') + '.db')
    if (-not (Test-Path -LiteralPath $backup)) {
        "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] daily backup start" |
            Out-File -FilePath $log -Append -Encoding utf8
        $backupOutput = & $node $cli backup --out $backup --keep 30 2>&1 | Out-String
        $backupOutput | Out-File -FilePath $log -Append -Encoding utf8
        Write-Output $backupOutput
        if ($LASTEXITCODE -ne 0) {
            throw "backup exited with code $LASTEXITCODE"
        }
        "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] daily backup done" |
            Out-File -FilePath $log -Append -Encoding utf8
    }
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] refresh done" |
        Out-File -FilePath $log -Append -Encoding utf8
}
catch {
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] refresh failed: $($_.Exception.Message)" |
        Out-File -FilePath $log -Append -Encoding utf8
    throw
}
finally {
    Pop-Location
}
