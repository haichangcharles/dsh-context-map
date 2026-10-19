# Own only the two AeDebug values for the duration of one keyless probe.
param([switch] $SelfTest)
function Invoke-WithNativePostmortem {
  param(
    [Microsoft.Win32.RegistryKey] $BaseKey,
    [string] $RegistryPath,
    [string] $DebuggerCommand,
    [scriptblock] $Run
  )
  $key = $BaseKey.OpenSubKey($RegistryPath, $true)
  $keyExisted = $null -ne $key
  $saved = @{}
  foreach ($name in @('Debugger', 'Auto')) {
    $exists = $keyExisted -and ($key.GetValueNames() -contains $name)
    $saved[$name] = @{ Exists = $exists }
    if ($exists) {
      $saved[$name].Value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $saved[$name].Kind = $key.GetValueKind($name)
    }
  }
  try {
    if (-not $keyExisted) { $key = $BaseKey.CreateSubKey($RegistryPath) }
    $key.SetValue('Debugger', $DebuggerCommand, [Microsoft.Win32.RegistryValueKind]::String)
    $key.SetValue('Auto', '1', [Microsoft.Win32.RegistryValueKind]::String)
    & $Run
  } finally {
    if ($null -ne $key) {
      try {
        foreach ($name in @('Debugger', 'Auto')) {
          if ($saved[$name].Exists) { $key.SetValue($name, $saved[$name].Value, $saved[$name].Kind) }
          else { $key.DeleteValue($name, $false) }
        }
        foreach ($name in @('Debugger', 'Auto')) {
          if ($saved[$name].Exists) {
            $actual = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            if ($key.GetValueKind($name) -ne $saved[$name].Kind -or (ConvertTo-Json -InputObject $actual -Compress) -cne (ConvertTo-Json -InputObject $saved[$name].Value -Compress)) { throw 'AeDebug restoration mismatch' }
          } elseif ($key.GetValueNames() -contains $name) { throw 'AeDebug restoration left an owned value' }
        }
        $removeKey = -not $keyExisted -and $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0
      } finally { $key.Dispose() }
      if ($removeKey) { $BaseKey.DeleteSubKey($RegistryPath, $false) }
    }
  }
}

if ($SelfTest) {
  $ErrorActionPreference = 'Stop'
  $base = [Microsoft.Win32.Registry]::CurrentUser
  $root = 'Software\DSH-Native-Debugger-Fixture-' + [guid]::NewGuid().ToString('N')
  $checks = 0
  try {
    foreach ($throws in @($false, $true)) {
      foreach ($shape in @('absent', 'unrelated', 'lowercase-expand')) {
        $path = "$root\$shape"
        if ($shape -ne 'absent') {
          $seed = $base.CreateSubKey($path)
          try {
            $seed.SetValue('Unrelated', 'keep')
            if ($shape -eq 'lowercase-expand') {
              $seed.SetValue('debugger', '%SystemRoot%\original.exe', [Microsoft.Win32.RegistryValueKind]::ExpandString)
              $seed.SetValue('auto', 0, [Microsoft.Win32.RegistryValueKind]::DWord)
            }
          } finally { $seed.Dispose() }
        }
        $observedThrow = $false
        try {
          Invoke-WithNativePostmortem $base $path 'fixture debugger' {
            $inside = $base.OpenSubKey($path)
            try {
              if ($inside.GetValue('Debugger') -cne 'fixture debugger' -or $inside.GetValue('Auto') -cne '1') { throw 'Fixture setup failed' }
            } finally { $inside.Dispose() }
            if ($throws) { throw 'EXPECTED_FIXTURE_FAILURE' }
          }
        } catch {
          if (-not $throws -or $_.Exception.Message -cne 'EXPECTED_FIXTURE_FAILURE') { throw }
          $observedThrow = $true
        }
        if ($observedThrow -ne $throws) { throw 'Fixture did not exercise its failure path' }
        $after = $base.OpenSubKey($path)
        try {
          if ($shape -eq 'absent') {
            if ($null -ne $after) { throw 'New registry key was not removed' }
          } else {
            if ($after.GetValue('Unrelated') -cne 'keep') { throw 'Unrelated registry value changed' }
            if ($shape -eq 'lowercase-expand') {
              if ($after.GetValue('debugger', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -cne '%SystemRoot%\original.exe' -or $after.GetValueKind('debugger') -ne [Microsoft.Win32.RegistryValueKind]::ExpandString -or $after.GetValue('auto') -ne 0 -or $after.GetValueKind('auto') -ne [Microsoft.Win32.RegistryValueKind]::DWord) { throw 'Typed lowercase values were not restored' }
            } elseif ($after.GetValueNames() -contains 'Debugger' -or $after.GetValueNames() -contains 'Auto') { throw 'New owned values remain' }
          }
        } finally { if ($null -ne $after) { $after.Dispose() } }
        $checks++
      }
    }
  } finally { $base.DeleteSubKeyTree($root, $false) }
  Write-Host "Engineering registry fixture: $checks passed; no machine settings used"
}
