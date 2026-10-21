# Preserve original test results; capture native child exceptions on disposable hosted Windows.
param([switch] $CaptureCrash, [ValidateSet('native', 'coverage')] [string] $Lane = 'native', [string] $ResultPath = '')
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
function Invoke-OriginalWindowsCheck {
  if ($Lane -eq 'coverage') {
    & pnpm run check:ci:coverage | Out-Host
    return $LASTEXITCODE
  }
  $nativeReport = Join-Path $env:RUNNER_TEMP 'required-native-report.json'
  & pnpm exec vitest run --no-file-parallelism --testTimeout 90000 `
    --reporter=default --reporter=json "--outputFile.json=$nativeReport" `
    packages/shell/tool-pwsh/tests/loader.spec.ts `
    packages/workflow/workflow-worker-thread/tests/workflow-worker-thread.spec.ts `
    packages/workflow/tool-ralph/tests/integration.spec.ts `
    packages/subprocess/subprocess-local/tests/process-exit.spec.ts | Out-Host
  return $LASTEXITCODE
}
if ($CaptureCrash) {
  # Workflow passes this only on disposable GitHub-hosted Windows; never touch a shared host.
  if ($env:DSH_EPHEMERAL_NATIVE_CAPTURE -cne '1') { throw 'Native crash capture requires an explicitly ephemeral runner' }
  $wrapperPath = $PSCommandPath
  $tools = & "$PSScriptRoot/prepare-native-debugger.ps1"
  . "$PSScriptRoot/native-postmortem-registry.ps1"
  . "$PSScriptRoot/native-live-debugger.ps1"
  . "$PSScriptRoot/windows-process-exit-evidence.ps1"
  $log = Join-Path $env:RUNNER_TEMP "required-$Lane-crash.log"
  Set-Content -LiteralPath $log -Value ''
  try {
    if ($Lane -eq 'native') {
      $nativeExitCode = Invoke-WithProcessExitEvidence {
        Invoke-NativeLiveDebugger $tools $wrapperPath (Join-Path $PSHOME 'pwsh.exe') $log $env:RUNNER_TEMP
      }
    } else {
      $command = '"{0}" -p %ld -e %ld -nosqm -noshell -y "{1}" -logo "{2}" -c ".echo DSH_UNHANDLED_NATIVE_EXCEPTION;.jdinfo 0x%p;kv 32;lm;q"' -f $tools.Debugger, $tools.Symbols, $log
      $nativeExitCode = Invoke-WithNativePostmortem ([Microsoft.Win32.Registry]::LocalMachine) 'SOFTWARE\Microsoft\Windows NT\CurrentVersion\AeDebug' $command { Invoke-WithProcessExitEvidence { Invoke-OriginalWindowsCheck } }
    }
  } finally { Get-Content -LiteralPath $log }
  if ((Get-Content -LiteralPath $log -Raw) -match '(?m)^\s*DSH_UNHANDLED_NATIVE_EXCEPTION\s*$') { throw "Required $Lane lane captured an unhandled native fault" }
} else {
  $nativeExitCode = Invoke-OriginalWindowsCheck
}
if ($ResultPath -ne '') {
  if ($CaptureCrash -or $nativeExitCode -isnot [int]) { throw 'Invalid inner native check result' }
  $file = [System.IO.File]::Open($ResultPath, [System.IO.FileMode]::CreateNew)
  $writer = [System.IO.StreamWriter]::new($file)
  try { $writer.Write((ConvertTo-Json -InputObject @{ exitCode = $nativeExitCode } -Compress)) }
  finally { $writer.Dispose() }
}
if ($nativeExitCode -ne 0) { throw "Original Windows $Lane check failed: $nativeExitCode" }
