# PageHeap owns only a previously absent, uniquely named diagnostic image key.
param([switch] $SelfTest)
function Invoke-WithOwnedPageHeap {
  param([Microsoft.Win32.RegistryKey] $BaseKey, [string] $RegistryRoot, [string] $ImageName,
    [scriptblock] $Configure, [scriptblock] $Run)
  if ($ImageName -cnotmatch '^dsh-worker-probe-[0-9a-f]{32}\.exe$') { throw 'PageHeap requires an exclusive diagnostic image name' }
  $path = "$RegistryRoot\$ImageName"
  $existing = $BaseKey.OpenSubKey($path)
  if ($null -ne $existing) { $existing.Dispose(); throw 'Owned PageHeap image key already exists' }
  try {
    & $Configure $true
    & $Run
  } finally {
    try { & $Configure $false }
    finally {
      $BaseKey.DeleteSubKeyTree($path, $false)
      $remaining = $BaseKey.OpenSubKey($path)
      if ($null -ne $remaining) { $remaining.Dispose(); throw 'Owned PageHeap image key was not removed' }
    }
  }
}

if ($SelfTest) {
  $ErrorActionPreference = 'Stop'
  $base = [Microsoft.Win32.Registry]::CurrentUser
  $root = 'Software\DSH-PageHeap-Fixture-' + [guid]::NewGuid().ToString('N')
  $image = 'dsh-worker-probe-' + [guid]::NewGuid().ToString('N') + '.exe'
  $null = $base.CreateSubKey($root).Dispose()
  try {
    foreach ($failure in @('none','enable','run','disable')) {
      $state = @{ enabled = 0; disabled = 0; ran = 0 }
      $caught = $false
      try {
        Invoke-WithOwnedPageHeap $base $root $image {
          param($enable)
          if ($enable) {
            $state.enabled++
            $key = $base.CreateSubKey("$root\$image")
            try { $key.SetValue('GlobalFlag', 'fixture') } finally { $key.Dispose() }
            if ($failure -eq 'enable') { throw 'EXPECTED_PAGEHEAP_enable' }
          } else {
            $state.disabled++
            if ($failure -eq 'disable') { throw 'EXPECTED_PAGEHEAP_disable' }
          }
        } {
          $state.ran++
          if ($failure -eq 'run') { throw 'EXPECTED_PAGEHEAP_run' }
        }
      } catch {
        if ($failure -eq 'none' -or $_.Exception.Message -cne "EXPECTED_PAGEHEAP_$failure") { throw }
        $caught = $true
      }
      $after = $base.OpenSubKey("$root\$image")
      if ($null -ne $after) { $after.Dispose(); throw 'PageHeap fixture leaked a key' }
      if ($state.enabled -ne 1 -or $state.disabled -ne 1 -or $state.ran -ne $(if ($failure -eq 'enable') { 0 } else { 1 }) -or $caught -ne ($failure -ne 'none')) { throw 'PageHeap fixture path mismatch' }
    }
    $key = $base.CreateSubKey("$root\$image")
    try { $key.SetValue('Unrelated', 'keep') } finally { $key.Dispose() }
    $collision = $false
    try { Invoke-WithOwnedPageHeap $base $root $image { throw 'Collision called configuration' } { throw 'Collision ran target' } }
    catch { if ($_.Exception.Message -cne 'Owned PageHeap image key already exists') { throw }; $collision = $true }
    $key = $base.OpenSubKey("$root\$image")
    try { if (-not $collision -or $key.GetValue('Unrelated') -cne 'keep') { throw 'PageHeap collision was modified' } }
    finally { $key.Dispose() }
  } finally { $base.DeleteSubKeyTree($root, $false) }
  Write-Host 'PageHeap fixture: five restoration/collision paths passed on HKCU; no target or machine settings used'
}
