# Failure-only diagnostic: separate normal source, artifact and plain Worker processes.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if ($env:DSH_EPHEMERAL_NATIVE_CAPTURE -cne '1') { throw 'Worker reduction requires a disposable hosted runner' }
$rows = [System.Collections.Generic.List[object]]::new()
$owned = $null
try {
  $owned = New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP ('dsh-worker-reduction-' + [guid]::NewGuid().ToString('N')))
  $tools = & "$PSScriptRoot/prepare-native-debugger.ps1"
  . "$PSScriptRoot/native-live-debugger.ps1"
  $driver = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../packages/workflow/workflow-worker-thread/tests/fixtures/worker-lifecycle-probe.mjs'))
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $tsconfig = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../tsconfig.base.json'))
  # The matched artifact control uses the normal Host build, never a rewritten worker.
  & pnpm run build:lib:host | Tee-Object -FilePath (Join-Path $env:RUNNER_TEMP 'worker-reduction-build.log') | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Cannot build the native worker control: $LASTEXITCODE" }
  foreach ($arm in @('source', 'built', 'plain')) {
    $wrapper = Join-Path $owned.FullName "$arm.ps1"
    $events = Join-Path $env:RUNNER_TEMP "worker-reduction-$arm-events.log"
    $template = @'
param([ValidateSet('native')] [string] $Lane, [string] $ResultPath)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
foreach ($key in @('DEEPSEEK_API_KEY','SILICONFLOW_API_KEY','TYPESAFE_API_KEY','OPENAI_API_KEY','JEV_API_KEY','OPENAI_BASE_URL')) {
  Remove-Item "Env:$key" -ErrorAction SilentlyContinue
}
$env:TSX_TSCONFIG_PATH = '__TSCONFIG__'
$arguments = @('--max-old-space-size=512')
if ('__ARM__' -eq 'source') { $arguments += @('--import','tsx/esm') }
$arguments += @('__DRIVER__','__ARM__')
& '__NODE__' @arguments | Tee-Object -FilePath '__EVENTS__' | Out-Host
$code = $LASTEXITCODE
$file = [System.IO.File]::Open($ResultPath, [System.IO.FileMode]::CreateNew)
$writer = [System.IO.StreamWriter]::new($file)
try { $writer.Write((ConvertTo-Json -InputObject @{ exitCode = $code } -Compress)) }
finally { $writer.Dispose() }
'@
    $template = $template.Replace('__ARM__', $arm).Replace('__DRIVER__', $driver.Replace("'", "''")).Replace('__NODE__', $node.Replace("'", "''")).Replace('__TSCONFIG__', $tsconfig.Replace("'", "''")).Replace('__EVENTS__', $events.Replace("'", "''"))
    Set-Content -LiteralPath $wrapper -Value $template
    $log = Join-Path $env:RUNNER_TEMP "worker-reduction-$arm-crash.log"
    Set-Content -LiteralPath $log -Value ''
    $ownership = @{ unconfirmed = $false }
    $runner = {
        param($executable, $arguments, $receipt)
        $start = [System.Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $executable
        $start.UseShellExecute = $false
        $start.WorkingDirectory = (Get-Location).Path
        foreach ($argument in $arguments) { $start.ArgumentList.Add([string] $argument) }
        $process = [System.Diagnostics.Process]::new()
        $process.StartInfo = $start
        $started = $false
        try {
          $started = $process.Start()
          if (-not $started) { throw 'Cannot start the diagnostic debugger' }
          if (-not $process.WaitForExit(150000)) {
            $ownership.unconfirmed = $true
            throw 'Unclosed native diagnostic process: timeout; descendant quiescence unconfirmed'
          }
          return $process.ExitCode
        } finally {
          try {
            if ($started -and -not $process.HasExited) {
              $ownership.unconfirmed = $true
              try {
                $process.Kill($true)
                if (-not $process.WaitForExit(5000)) { throw 'Owned debugger did not exit' }
              } catch { throw 'Unclosed native diagnostic process: termination failed' }
            }
          } finally { $process.Dispose() }
        }
    }.GetNewClosure()
    try {
      $code = Invoke-NativeLiveDebugger $tools $wrapper (Join-Path $PSHOME 'pwsh.exe') $log $owned.FullName $runner
      if ($code -ne 0) { throw "Original diagnostic result: $code" }
      $rows.Add(@{ arm = $arm; status = 'passed'; meaning = 'No fault observed in this fixed reduction, not a runtime repair' })
    } catch {
      $rows.Add(@{ arm = $arm; status = 'failed'; error = $_.Exception.Message.Substring(0, [Math]::Min(1200, $_.Exception.Message.Length)) })
      if ($ownership.unconfirmed) { throw 'Unclosed native diagnostic process; later arms blocked' }
    }
  }
} finally {
  foreach ($arm in @('source', 'built', 'plain')) {
    if (@($rows | Where-Object { $_.arm -eq $arm }).Count -eq 0) { $rows.Add(@{ arm = $arm; status = 'blocked' }) }
  }
  try {
    ConvertTo-Json -InputObject ($rows.ToArray()) -Depth 4 | Set-Content -LiteralPath (Join-Path $env:RUNNER_TEMP 'worker-reduction-summary.json')
  } finally { if ($null -ne $owned) { Remove-Item -LiteralPath $owned.FullName -Recurse -Force } }
}
if (@($rows | Where-Object { $_.status -ne 'passed' }).Count -gt 0) { throw 'Native worker reduction observed a failure; original required verdict remains failed' }
