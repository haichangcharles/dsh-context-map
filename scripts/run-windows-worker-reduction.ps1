# Failure-only diagnostic: one selected bounded worker control.
param([ValidateSet('source', 'dual-tsx-vm-timeout', 'dual-tsx-typescript', 'required-source-pageheap')] [string] $Arm = 'source')
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if ($env:DSH_EPHEMERAL_NATIVE_CAPTURE -cne '1') { throw 'Worker reduction requires a disposable hosted runner' }
$rows = [System.Collections.Generic.List[object]]::new()
$owned = $null
try {
  $owned = New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP ('dsh-worker-reduction-' + [guid]::NewGuid().ToString('N')))
  $tools = & "$PSScriptRoot/prepare-native-debugger.ps1"
  . "$PSScriptRoot/native-live-debugger.ps1"
  . "$PSScriptRoot/native-pageheap-image.ps1"
  $driver = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../packages/workflow/workflow-worker-thread/tests/fixtures/worker-lifecycle-probe.mjs'))
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $tsconfig = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../tsconfig.base.json'))
  $probeNode = $node
  if ($Arm -in @('source', 'required-source-pageheap')) {
    $imageName = 'dsh-worker-probe-' + [guid]::NewGuid().ToString('N') + '.exe'
    $probeNode = Join-Path $owned.FullName $imageName
    Copy-Item -LiteralPath $node -Destination $probeNode
    $gflags = Join-Path (Split-Path -Parent $tools.Debugger) 'gflags.exe'
    if (-not (Test-Path -LiteralPath $gflags)) { throw 'Microsoft GFlags is unavailable' }
  }
  if ($Arm -eq 'required-source-pageheap') {
    $packagePath = & $node '-p' "require.resolve('vitest/package.json')"
    if ($LASTEXITCODE -ne 0 -or @($packagePath).Count -ne 1) { throw 'Cannot resolve installed Vitest' }
    $vitestRoot = Split-Path -Parent $packagePath
    $vitestCli = Join-Path $vitestRoot 'vitest.mjs'
    $vitestWorker = Join-Path $vitestRoot 'dist/workers/forks.js'
    $witness = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'native-image-witness.mjs'))
    foreach ($file in @($vitestCli, $vitestWorker, $witness)) {
      if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Missing full-workload diagnostic input' }
    }
    if ((Get-FileHash -LiteralPath $node).Hash -cne (Get-FileHash -LiteralPath $probeNode).Hash) { throw 'Diagnostic Node copy differs' }
    $witnessPath = Join-Path $env:RUNNER_TEMP 'worker-reduction-required-source-pageheap-images.jsonl'
    [System.IO.File]::Open($witnessPath, [System.IO.FileMode]::CreateNew).Dispose()
    $witnessConfig = ConvertTo-Json -InputObject @{ output = $witnessPath; expectedExecutable = $probeNode; cli = $vitestCli; worker = $vitestWorker } -Compress
    $manifestFiles = @($node, $probeNode, $packagePath, $vitestCli, $vitestWorker, $witness) | ForEach-Object {
      @{ path = $_; sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash; bytes = (Get-Item -LiteralPath $_).Length }
    }
    ConvertTo-Json -InputObject @{ files = $manifestFiles; nodeVersion = (& $node '--version'); vitestVersion = (Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json).version;
      launch = 'owned Node executes installed Vitest CLI; original required command remains unchanged'; workerProtectionRequiresSavedEvidenceReview = $true } -Depth 5 |
      Set-Content -LiteralPath (Join-Path $env:RUNNER_TEMP 'worker-reduction-required-source-pageheap-manifest.json')
  }
  foreach ($arm in @($Arm)) {
    $wrapper = Join-Path $owned.FullName "$arm.ps1"
    $events = Join-Path $env:RUNNER_TEMP "worker-reduction-$arm-events.log"
    $template = @'
param([ValidateSet('native')] [string] $Lane, [string] $ResultPath)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
foreach ($key in @('DEEPSEEK_API_KEY','SILICONFLOW_API_KEY','TYPESAFE_API_KEY','OPENAI_API_KEY','JEV_API_KEY','OPENAI_BASE_URL')) {
  Remove-Item "Env:$key" -ErrorAction SilentlyContinue
}
if ('__ARM__' -ne 'required-source-pageheap') { $env:TSX_TSCONFIG_PATH = '__TSCONFIG__' }
$arguments = @('--max-old-space-size=512')
if ('__ARM__' -eq 'required-source-pageheap') {
  $env:DSH_NATIVE_IMAGE_WITNESS_CONFIG = '__WITNESS_CONFIG__'
  $witnessImport = '__WITNESS_URL__'
  $env:NODE_OPTIONS = "$($env:NODE_OPTIONS) --max-old-space-size=512 --import=$witnessImport"
  $arguments += @('__VITEST__', 'run', '--no-file-parallelism', '--testTimeout', '90000',
    '--reporter=default', '--reporter=json', '--outputFile.json=__REPORT__',
    'packages/shell/tool-pwsh/tests/loader.spec.ts',
    'packages/workflow/workflow-worker-thread/tests/workflow-worker-thread.spec.ts',
    'packages/workflow/tool-ralph/tests/integration.spec.ts',
    'packages/subprocess/subprocess-local/tests/process-exit.spec.ts')
} else {
  if ('__ARM__' -eq 'source') { $arguments += @('--import','tsx/esm') }
  $arguments += @('__DRIVER__','__ARM__')
}
& '__NODE__' @arguments | Tee-Object -FilePath '__EVENTS__' | Out-Host
$code = $LASTEXITCODE
$file = [System.IO.File]::Open($ResultPath, [System.IO.FileMode]::CreateNew)
$writer = [System.IO.StreamWriter]::new($file)
try { $writer.Write((ConvertTo-Json -InputObject @{ exitCode = $code } -Compress)) }
finally { $writer.Dispose() }
'@
    $template = $template.Replace('__ARM__', $arm).Replace('__DRIVER__', $driver.Replace("'", "''")).Replace('__NODE__', $probeNode.Replace("'", "''")).Replace('__TSCONFIG__', $tsconfig.Replace("'", "''")).Replace('__EVENTS__', $events.Replace("'", "''"))
    if ($arm -eq 'required-source-pageheap') {
      $report = Join-Path $env:RUNNER_TEMP 'worker-reduction-required-source-pageheap-report.json'
      $template = $template.Replace('__WITNESS_CONFIG__', $witnessConfig.Replace("'", "''")).Replace('__WITNESS_URL__', ([uri] $witness).AbsoluteUri.Replace("'", "''")).Replace('__VITEST__', $vitestCli.Replace("'", "''")).Replace('__REPORT__', $report.Replace("'", "''"))
    }
    Set-Content -LiteralPath $wrapper -Value $template
    $log = Join-Path $env:RUNNER_TEMP "worker-reduction-$arm-crash.log"
    Set-Content -LiteralPath $log -Value ''
    $ownership = @{ unconfirmed = $false }
    $receiptEvidence = @{ status = 'not-observed' }
    $savedReceipt = Join-Path $env:RUNNER_TEMP 'worker-reduction-required-source-pageheap-receipt.json'
    $debuggerWait = if ($arm -eq 'required-source-pageheap') { 450000 } else { 150000 }
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
          if (-not $process.WaitForExit($debuggerWait)) {
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
          } finally {
            try {
              if ($arm -eq 'required-source-pageheap') {
                try {
                  if (Test-Path -LiteralPath $receipt -PathType Leaf) {
                    [System.IO.File]::Copy($receipt, $savedReceipt, $false)
                    $receiptEvidence.status = 'saved'
                    $receiptEvidence.sha256 = (Get-FileHash -LiteralPath $savedReceipt -Algorithm SHA256).Hash
                    $receiptEvidence.bytes = (Get-Item -LiteralPath $savedReceipt).Length
                  } else { $receiptEvidence.status = 'missing' }
                } catch {
                  $receiptEvidence.status = 'copy-failed'
                  $receiptEvidence.error = $_.Exception.Message.Substring(0, [Math]::Min(1200, $_.Exception.Message.Length))
                }
              }
            } finally { $process.Dispose() }
          }
        }
    }.GetNewClosure()
    try {
      $configure = {
        param($enable)
        if ($enable) {
          & $gflags '/p' '/enable' $imageName '/full' | Out-Host
          if ($LASTEXITCODE -ne 0) { throw 'Cannot enable diagnostic full PageHeap' }
          $listed = & $gflags '/p'
          if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect diagnostic PageHeap settings' }
          $verified = @($listed | Where-Object { $_ -match ([regex]::Escape($imageName) + '.*full traces') })
          if ($verified.Count -ne 1) { throw 'Full PageHeap was not confirmed for the owned image' }
          $verified | Set-Content -LiteralPath (Join-Path $env:RUNNER_TEMP 'worker-reduction-pageheap-flags.log')
          $verified | Out-Host
          Write-Host 'DSH_OWNED_FULL_PAGEHEAP_READY'
        } else {
          & $gflags '/p' '/disable' $imageName | Out-Host
          if ($LASTEXITCODE -ne 0) { throw 'Cannot disable diagnostic full PageHeap' }
        }
      }.GetNewClosure()
      if ($arm -in @('source', 'required-source-pageheap')) {
        $code = Invoke-WithOwnedPageHeap ([Microsoft.Win32.Registry]::LocalMachine) 'SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options' $imageName $configure {
          Invoke-NativeLiveDebugger $tools $wrapper (Join-Path $PSHOME 'pwsh.exe') $log $owned.FullName $runner
        }
      } else {
        $code = Invoke-NativeLiveDebugger $tools $wrapper (Join-Path $PSHOME 'pwsh.exe') $log $owned.FullName $runner
      }
      if ($code -ne 0) { throw "Original diagnostic result: $code" }
      if ($arm -eq 'required-source-pageheap') {
        if ($receiptEvidence.status -ne 'saved') { throw 'Full-workload exit receipt was not retained' }
        $rows.Add(@{ arm = $arm; status = 'completed'; workerProtectionRequiresSavedEvidenceReview = $true; rawNativeFault = $false;
          originalReceipt = $receiptEvidence;
          meaning = 'Receipt settled; complete inventory and actual worker protection still require independent saved-evidence review' })
      } else {
        $rows.Add(@{ arm = $arm; status = 'passed'; meaning = 'No fault observed in this fixed reduction, not a runtime repair' })
      }
    } catch {
      $rawEvidence = Get-Content -LiteralPath $log -Raw
      $rows.Add(@{ arm = $arm; status = 'failed'; error = $_.Exception.Message.Substring(0, [Math]::Min(1200, $_.Exception.Message.Length));
        originalReceipt = $receiptEvidence;
        rawNativeFault = [bool] ($rawEvidence -match 'HEAP: Free Heap block[^\r\n]*modified[^\r\n]*after it was freed|(?m)^\s*VERIFIER STOP [0-9a-f]+\s*:|(?m)^\s*DSH_UNHANDLED_NATIVE_EXCEPTION\s*$') })
      if ($ownership.unconfirmed) { throw 'Unclosed native diagnostic process; later arms blocked' }
    }
  }
} finally {
  foreach ($arm in @($Arm)) {
    if (@($rows | Where-Object { $_.arm -eq $arm }).Count -eq 0) { $rows.Add(@{ arm = $arm; status = 'blocked' }) }
  }
  try {
    ConvertTo-Json -InputObject ($rows.ToArray()) -Depth 4 | Set-Content -LiteralPath (Join-Path $env:RUNNER_TEMP 'worker-reduction-summary.json')
  } finally { if ($null -ne $owned) { Remove-Item -LiteralPath $owned.FullName -Recurse -Force } }
}
if (@($rows | Where-Object { $_.status -notin @('passed', 'completed') }).Count -gt 0) { throw 'Native worker reduction observed a failure; original required verdict remains failed' }
