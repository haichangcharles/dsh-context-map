# Run the original native lane once, following forks and recording unhandled native stacks.
$ErrorActionPreference = 'Stop'
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
# Second-chance AV only: V8 may handle first-chance exceptions normally.
# -o follows Vitest's Node forks; -hd preserves the ordinary heap policy.
$commands = 'sxd -c2 ".echo DSH_UNHANDLED_NATIVE_EXCEPTION;.exr -1;.ecxr;kv 32;lm;q" av;g'
& $debugger -o -g -G -hd -nosqm -noshell -y "$symbols;srv*$symbols*https://msdl.microsoft.com/download/symbols" -logo $log -c $commands `
  $node $vitest run --no-file-parallelism --maxWorkers=2 --testTimeout 90000 --reporter=default --reporter=json "--outputFile.json=$report" `
  packages/shell/tool-pwsh/tests/loader.spec.ts `
  packages/workflow/workflow-worker-thread/tests/workflow-worker-thread.spec.ts `
  packages/workflow/tool-ralph/tests/integration.spec.ts `
  packages/subprocess/subprocess-local/tests/process-exit.spec.ts 2>&1 | Tee-Object -FilePath $console
$debuggerExitCode = $LASTEXITCODE
Write-Host "CDB exit code: $debuggerExitCode"
if ($debuggerExitCode -ne 0) { throw "CDB failed: $debuggerExitCode" }
node scripts/verify-native-debugger-result.mjs $report $log $console
if ($LASTEXITCODE -ne 0) { throw 'Native debugger result failed verification' }
