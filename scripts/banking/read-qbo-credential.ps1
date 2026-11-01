param([switch]$Presence)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TdlQboCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential {
    public UInt32 Flags, Type; public IntPtr TargetName, Comment;
    public Int64 LastWritten; public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob; public UInt32 Persist, AttributeCount;
    public IntPtr Attributes, TargetAlias, UserName;
  }
  [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Read(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("Advapi32.dll")] public static extern void CredFree(IntPtr credential);
}
'@
  $pointer = [IntPtr]::Zero
  if (-not [TdlQboCredential]::Read('TestDataLab/QBO/production/2856', 1, 0, [ref]$pointer)) {
    [Console]::Out.Write('{"configured":false}'); exit 2
  }
  try {
    $entry = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][TdlQboCredential+Credential])
    if ($Presence) { [Console]::Out.Write('{"configured":true}'); exit 0 }
    $username = [Runtime.InteropServices.Marshal]::PtrToStringUni($entry.UserName)
    if ($entry.CredentialBlobSize -lt 2 -or $entry.CredentialBlobSize -gt 5120 -or ($entry.CredentialBlobSize % 2) -ne 0) { throw 'Invalid credential' }
    $bytes = New-Object byte[] $entry.CredentialBlobSize
    [Runtime.InteropServices.Marshal]::Copy($entry.CredentialBlob, $bytes, 0, $bytes.Length)
    try {
      $password = [Text.Encoding]::Unicode.GetString($bytes).TrimEnd([char]0)
      if ([string]::IsNullOrWhiteSpace($username) -or [string]::IsNullOrEmpty($password)) { throw 'Incomplete credential' }
      # Private pipe only: invoked by qbo-browser-transport, never by a model/tool.
      [Console]::Out.Write((@{username=$username;password=$password} | ConvertTo-Json -Compress))
    } finally { [Array]::Clear($bytes, 0, $bytes.Length); $password = $null; $username = $null }
  } finally { [TdlQboCredential]::CredFree($pointer) }
} catch { [Console]::Out.Write('{"configured":false}'); exit 3 }
