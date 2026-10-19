# Microsoft-only debugger preparation; no target process or registry mutation.
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
7z x $archive "-o$symbols" -y | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Cannot extract matching public Node symbols' }
[pscustomobject]@{ Debugger = $debugger; Symbols = "$symbols;srv*$symbols*https://msdl.microsoft.com/download/symbols" }
