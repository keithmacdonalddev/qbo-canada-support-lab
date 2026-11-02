$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.credentialId -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') { throw 'Invalid credential id' }
  $directory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'TestDataLab\agent-access'
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  if (([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Invalid private directory' }
  $file = Join-Path $directory ('credential-' + $request.credentialId + '.dpapi')
  $entropy = [Text.Encoding]::UTF8.GetBytes('TestDataLab.AgentAppCredential.v1')
  if ($request.action -eq 'write') {
    $plain = [Text.Encoding]::UTF8.GetBytes(($request.record | ConvertTo-Json -Compress -Depth 5))
    try { $encrypted = [Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser) }
    finally { [Array]::Clear($plain,0,$plain.Length) }
    $stream = [IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($encrypted,0,$encrypted.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    [Console]::Out.Write('{"stored":true}')
  } elseif ($request.action -eq 'read') {
    if (([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Invalid private file' }
    $encrypted = [IO.File]::ReadAllBytes($file)
    if ($encrypted.Length -gt 16384) { throw 'Invalid credential' }
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($encrypted,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    try {
      # Private pipe only. The Node helper never forwards this output to a model.
      [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
    } finally { [Array]::Clear($plain,0,$plain.Length) }
  } else { throw 'Invalid action' }
} catch { [Console]::Out.Write('{"error":"Private app credential unavailable"}'); exit 1 }
