# Run the original native lane once, following forks and recording unhandled native stacks.
param([ValidateSet('launch', 'postmortem')][string] $Mode = 'launch')
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$debugger = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\Debuggers\x64\cdb.exe'
if (-not (Test-Path -LiteralPath $debugger)) {
  $installer = Join-Path $env:RUNNER_TEMP 'winsdksetup.exe'
  Invoke-WebRequest 'https://go.microsoft.com/fwlink/?linkid=2272610' -OutFile $installer
  $signature = Get-AuthenticodeSignature -LiteralPath $installer
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
    throw 'Windows SDK installer signature is not valid Microsoft code'
  }
  $setup = Start-Process -FilePath $installer -ArgumentList '/features','OptionId.WindowsDesktopDebuggers','/quiet','/norestart' -PassThru -Wait -NoNewWindow
  if ($setup.ExitCode -notin 0,3010) { throw "Windows debugger install failed: $($setup.ExitCode)" }
}
if (-not (Test-Path -LiteralPath $debugger)) { throw 'Microsoft CDB was not installed' }
$symbols = Join-Path $env:RUNNER_TEMP 'dsh-cdb-symbols'
New-Item -ItemType Directory -Path $symbols -Force | Out-Null
$version = node -p 'process.version'
$archive = Join-Path $symbols 'node_pdb.7z'
Invoke-WebRequest "https://nodejs.org/dist/$version/win-x64/node_pdb.7z" -OutFile $archive
7z x $archive "-o$symbols" -y
if ($LASTEXITCODE -ne 0) { throw 'Cannot extract matching public Node symbols' }
$node = (Get-Command node).Source
$vitest = Join-Path $PWD 'node_modules\vitest\vitest.mjs'
$report = Join-Path $env:RUNNER_TEMP 'native-debugger-result.json'
$log = Join-Path $env:RUNNER_TEMP 'native-debugger.log'
$console = Join-Path $env:RUNNER_TEMP 'native-debugger-console.log'
$symbolPath = "$symbols;srv*$symbols*https://msdl.microsoft.com/download/symbols"
$testArguments = @($vitest, 'run', '--no-file-parallelism', '--maxWorkers=2', '--testTimeout', '90000',
  '--reporter=default', '--reporter=json', "--outputFile.json=$report",
  'packages/shell/tool-pwsh/tests/loader.spec.ts',
  'packages/workflow/workflow-worker-thread/tests/workflow-worker-thread.spec.ts',
  'packages/workflow/tool-ralph/tests/integration.spec.ts',
  'packages/subprocess/subprocess-local/tests/process-exit.spec.ts')
if ($Mode -eq 'launch') {
  # Second-chance AV only: V8 may handle first-chance exceptions normally.
  # -o follows Vitest forks; -hd preserves the ordinary heap policy.
  $commands = 'sxd -c2 ".echo DSH_UNHANDLED_NATIVE_EXCEPTION;.exr -1;.ecxr;kv 32;lm;q" av;g'
  & $debugger -o -g -G -hd -nosqm -noshell -y $symbolPath -logo $log -c $commands $node @testArguments 2>&1 | Tee-Object -FilePath $console
  $nativeExitCode = $LASTEXITCODE
} else {
  # Microsoft AeDebug JIT_DEBUG_INFO preserves the fault context without a pre-attached debugger.
  $registryPath = 'SOFTWARE\Microsoft\Windows NT\CurrentVersion\AeDebug'
  . "$PSScriptRoot/native-postmortem-registry.ps1"
  Set-Content -LiteralPath $log -Value ''
  $command = '"{0}" -p %ld -e %ld -nosqm -noshell -y "{1}" -logo "{2}" -c ".echo DSH_UNHANDLED_NATIVE_EXCEPTION;.jdinfo 0x%p;kv 32;lm;q"' -f $debugger, $symbolPath, $log
  try {
    $nativeExitCode = Invoke-WithNativePostmortem ([Microsoft.Win32.Registry]::LocalMachine) $registryPath $command {
      & $node @testArguments 2>&1 | Tee-Object -FilePath $console | Out-Host
      return $LASTEXITCODE
    }
  } finally { Get-Content -LiteralPath $log }

}
Write-Host "Native $Mode exit code: $nativeExitCode"
if ($nativeExitCode -ne 0) { throw "Native $Mode failed: $nativeExitCode" }
node scripts/verify-native-debugger-result.mjs $report $log $console
if ($LASTEXITCODE -ne 0) { throw 'Native debugger result failed verification' }
