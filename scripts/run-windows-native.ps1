# Preserve required Windows commands; attach CDB only if a hosted target crashes.
param([switch] $CaptureCrash, [ValidateSet('native', 'coverage')] [string] $Lane = 'native')
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
function Invoke-OriginalWindowsCheck {
  if ($Lane -eq 'coverage') {
    & pnpm run check:ci:coverage | Out-Host
    return $LASTEXITCODE
  }
  & pnpm exec vitest run --no-file-parallelism --testTimeout 90000 `
    packages/shell/tool-pwsh/tests/loader.spec.ts `
    packages/workflow/workflow-worker-thread/tests/workflow-worker-thread.spec.ts `
    packages/workflow/tool-ralph/tests/integration.spec.ts `
    packages/subprocess/subprocess-local/tests/process-exit.spec.ts | Out-Host
  return $LASTEXITCODE
}
if ($CaptureCrash) {
  # Workflow passes this only on disposable GitHub-hosted Windows; never touch a shared host.
  if ($env:DSH_EPHEMERAL_NATIVE_CAPTURE -cne '1') { throw 'Native crash capture requires an explicitly ephemeral runner' }
  $tools = & "$PSScriptRoot/prepare-native-debugger.ps1"
  . "$PSScriptRoot/native-postmortem-registry.ps1"
  . "$PSScriptRoot/windows-process-exit-evidence.ps1"
  $log = Join-Path $env:RUNNER_TEMP "required-$Lane-crash.log"
  Set-Content -LiteralPath $log -Value ''
  $command = '"{0}" -p %ld -e %ld -nosqm -noshell -y "{1}" -logo "{2}" -c ".echo DSH_UNHANDLED_NATIVE_EXCEPTION;.jdinfo 0x%p;kv 32;lm;q"' -f $tools.Debugger, $tools.Symbols, $log
  try {
    $nativeExitCode = Invoke-WithNativePostmortem ([Microsoft.Win32.Registry]::LocalMachine) 'SOFTWARE\Microsoft\Windows NT\CurrentVersion\AeDebug' $command { Invoke-WithProcessExitEvidence { Invoke-OriginalWindowsCheck } }
  } finally { Get-Content -LiteralPath $log }
  if ((Get-Content -LiteralPath $log -Raw) -match '(?m)^\s*DSH_UNHANDLED_NATIVE_EXCEPTION\s*$') { throw "Required $Lane lane captured an unhandled native fault" }
} else {
  $nativeExitCode = Invoke-OriginalWindowsCheck
}
if ($nativeExitCode -ne 0) { throw "Original Windows $Lane check failed: $nativeExitCode" }
