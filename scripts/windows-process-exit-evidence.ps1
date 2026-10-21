# Best-effort OS metadata; this observer never decides the test verdict.
param([switch] $SelfTest)

function Select-OwnedProcessExits {
  param([object[]] $Records, [uint32] $RootProcessId)
  $owned = [System.Collections.Generic.HashSet[uint32]]::new()
  $null = $owned.Add($RootProcessId)
  $starts = 0; $stops = 0; $nonzero = 0
  $details = [System.Collections.Generic.List[object]]::new()
  foreach ($record in ($Records | Sort-Object Time, @{ Expression = { if ($_.Kind -eq 'start') { 0 } else { 1 } } })) {
    $processId = [uint32] $record.ProcessId
    if ($processId -eq $RootProcessId) { continue }
    if ($record.Kind -eq 'start') {
      # A new unrelated start revokes ownership of a reused PID.
      $parentOwned = $owned.Contains([uint32] $record.ParentId)
      $null = $owned.Remove($processId)
      if ($parentOwned) { $null = $owned.Add($processId); $starts++ }
    } elseif ($owned.Remove($processId)) {
      $stops++
      if ([uint32] $record.ExitStatus -ne 0) {
        $nonzero++
        if ($details.Count -lt 32) {
          $details.Add([ordered]@{ ProcessId = $processId; ParentId = [uint32] $record.ParentId
            Name = [string] $record.Name; Time = [string] $record.Time
            ExitStatus = [uint32] $record.ExitStatus; ExitHex = '0x{0:X8}' -f [uint32] $record.ExitStatus })
        }
      }
    }
  }
  return [ordered]@{ BestEffort = $true; OwnedStarts = $starts; OwnedStops = $stops
    NonzeroStops = $nonzero; OmittedDetails = $nonzero - $details.Count; Details = @($details.ToArray()) }
}

function Remove-ProcessExitSubscriptions {
  param([string[]] $Identifiers)
  foreach ($identifier in $Identifiers) {
    try { Unregister-Event -SourceIdentifier $identifier -ErrorAction Stop }
    catch { Write-Warning "OS exit observer unsubscribe failed: $($_.Exception.Message)" }
    foreach ($event in @(Get-Event -SourceIdentifier $identifier -ErrorAction SilentlyContinue)) {
      Remove-Event -EventIdentifier $event.EventIdentifier -ErrorAction SilentlyContinue
    }
  }
}

function Invoke-WithProcessExitEvidence {
  [CmdletBinding()]
  param([scriptblock] $Run)
  $prefix = 'dsh-native-exit-' + [guid]::NewGuid().ToString('N')
  $identifiers = @()
  try {
    foreach ($kind in @('start', 'stop')) {
      $identifier = "$prefix-$kind"
      $class = if ($kind -eq 'start') { 'Win32_ProcessStartTrace' } else { 'Win32_ProcessStopTrace' }
      Register-CimIndicationEvent -Namespace root/cimv2 -Query "SELECT * FROM $class" -SourceIdentifier $identifier -ErrorAction Stop | Out-Null
      $identifiers += $identifier
    }
  } catch {
    Remove-ProcessExitSubscriptions $identifiers
    Write-Warning "OS exit observer unavailable; original command still runs once: $($_.Exception.Message)"
    return (& $Run)
  }
  try {
    & $Run
  } finally {
    try {
      $records = [System.Collections.Generic.List[object]]::new()
      $omitted = 0
      foreach ($kind in @('start', 'stop')) {
        foreach ($event in @(Get-Event -SourceIdentifier "$prefix-$kind" -ErrorAction SilentlyContinue)) {
          if ($records.Count -ge 50000) { $omitted++; continue }
          $raw = $event.SourceEventArgs.NewEvent
          $records.Add([pscustomobject]@{ Kind = $kind; Time = [uint64] $raw.TIME_CREATED
            ProcessId = [uint32] $raw.ProcessID; ParentId = [uint32] $raw.ParentProcessID
            Name = [string] $raw.ProcessName; ExitStatus = if ($kind -eq 'stop') { [uint32] $raw.ExitStatus } else { 0 } })
        }
      }
      $summary = Select-OwnedProcessExits $records.ToArray() $PID
      $summary['OmittedNotifications'] = $omitted
      Write-Host ('DSH_OS_PROCESS_EXITS ' + (ConvertTo-Json -InputObject $summary -Depth 5 -Compress))
    } catch {
      Write-Warning "OS exit evidence incomplete: $($_.Exception.Message)"
    } finally {
      Remove-ProcessExitSubscriptions $identifiers
    }
  }
}

if ($SelfTest) {
  $ErrorActionPreference = 'Stop'
  function Event($kind, $time, $processId, $parentId, $status = 0) {
    [pscustomobject]@{ Kind = $kind; Time = $time; ProcessId = $processId; ParentId = $parentId; ExitStatus = $status; Name = 'fixture.exe' }
  }
  $records = @((Event start 1 20 10), (Event start 2 30 20), (Event stop 3 20 10),
    (Event stop 4 30 20 3221225477), (Event start 5 30 999), (Event stop 6 30 999 99),
    (Event stop 7 999 1 13), (Event start 8 20 999), (Event stop 9 20 999 11),
    (Event start 10 40 10), (Event stop 11 40 10 7), (Event start 12 50 10), (Event stop 12 50 10))
  $selected = Select-OwnedProcessExits @($records[12..0]) 10
  if ($selected.OwnedStarts -ne 4 -or $selected.OwnedStops -ne 4 -or $selected.NonzeroStops -ne 2 -or $selected.Details[0].ExitHex -cne '0xC0000005' -or $selected.Details[1].ProcessId -ne 40) { throw 'Owned exit ordering/PID reuse fixture failed' }
  if ((Select-OwnedProcessExits @() 10).OwnedStops -ne 0) { throw 'Empty observation fixture failed' }
  $many = @(foreach ($n in 1..40) { Event start ($n * 2) ($n + 100) 10; Event stop ($n * 2 + 1) ($n + 100) 10 7 })
  $bounded = Select-OwnedProcessExits $many 10
  if ($bounded.NonzeroStops -ne 40 -or $bounded.Details.Count -ne 32 -or $bounded.OmittedDetails -ne 8) { throw 'Exit detail bound fixture failed' }
  # Use real private event subscriptions; mock only unavailable OS registration.
  function Register-CimIndicationEvent {
    [CmdletBinding()] param($Namespace, $Query, $SourceIdentifier)
    if ($script:exitFixtureSetupFails -and $SourceIdentifier.EndsWith('-stop')) { throw 'EXPECTED_OBSERVER_SETUP_FAILURE' }
    Register-EngineEvent -SourceIdentifier $SourceIdentifier -Forward
  }
  try {
    foreach ($setupFails in @($false, $true)) {
      $script:exitFixtureSetupFails = $setupFails
      foreach ($throws in @($false, $true)) {
        $script:exitFixtureCalls = 0
        $caught = $false
        try {
          $result = @(Invoke-WithProcessExitEvidence {
            $script:exitFixtureCalls++
            $expectedSubscriptions = if ($setupFails) { 0 } else { 2 }
            if (@(Get-EventSubscriber | Where-Object SourceIdentifier -like 'dsh-native-exit-*').Count -ne $expectedSubscriptions) { throw 'Fixture did not reach the intended observer setup path' }
            if ($throws) { throw 'EXPECTED_ORIGINAL_FAILURE' }
            return 17
          } -WarningAction SilentlyContinue)
          if ($throws -or $result.Count -ne 1 -or $result[0] -ne 17) { throw 'Original return was changed' }
        } catch {
          if (-not $throws -or $_.Exception.Message -cne 'EXPECTED_ORIGINAL_FAILURE') { throw }
          $caught = $true
        }
        if ($caught -ne $throws -or $script:exitFixtureCalls -ne 1 -or @(Get-EventSubscriber | Where-Object SourceIdentifier -like 'dsh-native-exit-*').Count -ne 0) { throw 'Observer failure changed invocation or leaked subscription' }
      }
    }
  } finally { Remove-Item Function:\Register-CimIndicationEvent }
  Write-Host 'Engineering process-exit fixtures passed; no Windows processes or model calls used'
}
