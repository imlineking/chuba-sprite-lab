import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { firstAccountName } from "./user-profile.mjs";
const runFile=promisify(execFile);
let accountNamePromise;
async function readAccountName() {
  if(process.platform==="win32") {
    try {
      // Query display names for the current SID only. Never use the machine/registered owner.
      const command=`[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
$name='';
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop;
  $user=[Windows.System.User,Windows.System,ContentType=WindowsRuntime]::GetDefault();
  $operation=$user.GetPropertyAsync('firstName');
  $asTask=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetGenericArguments().Count -eq 1} | Select-Object -First 1;
  $wait=$asTask.MakeGenericMethod([object]).Invoke($null,@($operation));
  if($wait.Wait(2500)) {$name=[string]$wait.Result}
} catch {}
if (!$name) { try { $name=(Get-LocalUser -SID $sid -ErrorAction Stop).FullName } catch {} }
if (!$name) { try { $logon=Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Authentication\\LogonUI' -ErrorAction Stop; if($logon.LastLoggedOnUserSID -eq $sid.Value) {$name=$logon.LastLoggedOnDisplayName} } catch {} }
if (!$name) { try { $cache='HKLM:\\SOFTWARE\\Microsoft\\IdentityStore\\Cache\\'+$sid.Value; if(Test-Path -LiteralPath $cache) { foreach($key in Get-ChildItem -LiteralPath $cache -Recurse -ErrorAction SilentlyContinue) {$candidate=$key.GetValue('DisplayName');if($candidate){$name=$candidate;break}} } } catch {} }
if (!$name) { $name=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name.Split([char]92)[-1] }
$name`;
      const executable=path.join(process.env.SystemRoot||"C:\\Windows","System32/WindowsPowerShell/v1.0/powershell.exe");
      const {stdout}=await runFile(executable,["-NoProfile","-NonInteractive","-Command",command],{windowsHide:true,timeout:6000,encoding:"utf8",maxBuffer:16384});
      if(stdout.trim()) return firstAccountName(stdout);
    } catch { /* A locked-down account still has a login name. */ }
  }
  try { return firstAccountName(os.userInfo().username); } catch { return ""; }
}
export function windowsLoginName() { return accountNamePromise ||= readAccountName(); }
