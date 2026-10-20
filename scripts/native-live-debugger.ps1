# Capture live native exceptions without replacing the original test verdict.
param([switch] $SelfTest)

function Invoke-NativeLiveDebugger {
  param($Tools, [string] $WrapperPath, [string] $ShellPath, [string] $LogPath, [string] $TemporaryRoot,
    [scriptblock] $Runner = { param($executable, $arguments, $receipt) & $executable @arguments | Out-Host; return $LASTEXITCODE })
  $owned = Join-Path $TemporaryRoot ('dsh-live-native-' + [guid]::NewGuid().ToString('N'))
  $null = New-Item -ItemType Directory -Path $owned
  try {
    $receipt = Join-Path $owned 'result.json'
    $commands = Join-Path $owned 'commands.txt'
    $first = '.echo DSH_FIRST_CHANCE_AV;.lastevent;.exr -1;.ecxr;kv 32;gn'
    $second = '.echo DSH_UNHANDLED_NATIVE_EXCEPTION;.lastevent;.exr -1;.ecxr;kv 32;lm;gn'
    Set-Content -LiteralPath $commands -Value ('sxd -c "{0}" -c2 "{1}" av;g' -f $first, $second)
    $arguments = @('-o', '-g', '-G', '-nosqm', '-noshell', '-y', $Tools.Symbols,
      '-logo', $LogPath, '-cf', $commands, $ShellPath, '-NoLogo', '-NoProfile', '-NonInteractive',
      '-File', $WrapperPath, '-Lane', 'native', '-ResultPath', $receipt)
    $debuggerExit = & $Runner $Tools.Debugger $arguments $receipt
    if (-not (Test-Path -LiteralPath $receipt)) { throw "Missing original native check result; debugger exit: $debuggerExit" }
    $result = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $result -or @($result.PSObject.Properties).Count -ne 1 -or
      ($result.exitCode -isnot [int] -and $result.exitCode -isnot [long])) { throw 'Malformed original native check result' }
    if ($result.exitCode -lt [int]::MinValue -or $result.exitCode -gt [int]::MaxValue) { throw 'Original native result is outside int32' }
    if ($debuggerExit -ne 0) { throw "Native debugger failed: $debuggerExit; original native check result: $($result.exitCode)" }
    if ((Get-Content -LiteralPath $LogPath -Raw) -match '(?m)^\s*DSH_UNHANDLED_NATIVE_EXCEPTION\s*$') {
      throw 'Required native lane captured an unhandled native fault'
    }
    return [int] $result.exitCode
  } finally {
    Remove-Item -LiteralPath $owned -Recurse -Force
  }
}

if ($SelfTest) {
  $ErrorActionPreference = 'Stop'
  $root = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-live-debugger-fixture-' + [guid]::NewGuid().ToString('N'))
  $null = New-Item -ItemType Directory -Path $root
  try {
    foreach ($case in @('zero', 'nonzero', 'first', 'second', 'missing', 'malformed', 'debugger')) {
      $script:liveFixtureCase = $case
      $script:liveFixtureCalls = 0
      $log = Join-Path $root 'fixture.log'
      Set-Content -LiteralPath $log -Value ''
      $caught = $false
      try {
        $result = Invoke-NativeLiveDebugger @{ Debugger = 'fixture.exe'; Symbols = 'fixture' } 'wrapper.ps1' 'pwsh.exe' $log $root {
          param($executable, $arguments, $receipt)
          $script:liveFixtureCalls++
          if ($executable -cne 'fixture.exe' -or $arguments[0] -cne '-o' -or
            $arguments[-1] -cne $receipt -or ($arguments -join ' ') -notmatch '-Lane native -ResultPath') { throw 'Bad debugger invocation' }
          if ($script:liveFixtureCase -eq 'missing') { return 0 }
          if ($script:liveFixtureCase -eq 'first') { Set-Content -LiteralPath $log -Value 'DSH_FIRST_CHANCE_AV' }
          if ($script:liveFixtureCase -eq 'second') { Set-Content -LiteralPath $log -Value 'DSH_UNHANDLED_NATIVE_EXCEPTION' }
          $body = if ($script:liveFixtureCase -eq 'malformed') { '{"exitCode":"0"}' }
            elseif ($script:liveFixtureCase -eq 'nonzero') { '{"exitCode":23}' } else { '{"exitCode":0}' }
          Set-Content -LiteralPath $receipt -Value $body
          if ($script:liveFixtureCase -eq 'debugger') { return 9 }
          return 0
        }
        $expected = if ($case -eq 'nonzero') { 23 } else { 0 }
        if ($case -notin 'zero','nonzero','first' -or $result -ne $expected) { throw 'Fixture verdict mismatch' }
      } catch {
        $expectedError = switch ($case) {
          'second' { 'unhandled native fault' }; 'missing' { 'Missing original' }
          'malformed' { 'Malformed original' }; 'debugger' { 'Native debugger failed' }
          default { '__UNEXPECTED_FIXTURE_ERROR__' }
        }
        if ($_.Exception.Message -notlike "*$expectedError*") { throw }
        $caught = $true
      }
      if ($caught -ne ($case -notin 'zero','nonzero','first') -or $script:liveFixtureCalls -ne 1 -or
        @(Get-ChildItem -LiteralPath $root -Directory).Count -ne 0) { throw 'Debugger verdict or cleanup fixture failed' }
    }
  } finally { Remove-Item -LiteralPath $root -Recurse -Force }
  Write-Host 'Live debugger receipt fixtures passed; no target process or model invoked'
}
