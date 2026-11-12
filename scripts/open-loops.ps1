$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root 'dist\src\loops\cli.js'
$callerDir = (Get-Location).Path

if (-not (Test-Path -LiteralPath $cli)) {
    throw "open-loops CLI not built: $cli (run npm run build)"
}

$node = (Get-Command node -ErrorAction Stop).Source
$exitCode = 0
$cliArgs = @($args)

if ($cliArgs.Count -gt 0 -and
    $cliArgs[0] -eq 'digest' -and
    -not ($cliArgs -contains '--project') -and
    -not ($cliArgs -contains '--no-project-focus')) {
    $cliArgs += @('--project', $callerDir)
}

Push-Location $root
try {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & $node $cli @cliArgs 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousPreference
    $text = (($output | ForEach-Object { [string]$_ }) -join "`n")
    if ($exitCode -ne 0 -and
        $cliArgs.Count -gt 0 -and
        $cliArgs[0] -eq 'digest' -and
        -not ($cliArgs -contains '--no-mark') -and
        $text -match 'unable to open database file|attempt to write a readonly database|SQLITE_READONLY') {
        $retryArgs = @($cliArgs) + '--no-mark' + '--readonly-fallback'
        $ErrorActionPreference = 'Continue'
        $retryOutput = & $node $cli @retryArgs 2>&1
        $retryExit = $LASTEXITCODE
        $ErrorActionPreference = $previousPreference
        if ($retryExit -eq 0) {
            $retryOutput | ForEach-Object { Write-Output ([string] $_) }
            exit 0
        }
        $output = $retryOutput
        $exitCode = $retryExit
    }
    $output | ForEach-Object { Write-Output ([string] $_) }
}
finally {
    Pop-Location
}

exit $exitCode
