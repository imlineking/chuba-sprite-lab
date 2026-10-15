$ErrorActionPreference='Stop'
$repo='C:/Users/User/Documents/ChatGPT/lab/chuba-sprite-lab'
$tempRoot='C:/Users/User/AppData/Local/Temp'
$cacheRoot='C:/Users/User/AppData/Local/ChubaSpriteLab/offline'
$backup='C:/Users/User/Pictures/Chuba/chuba the game/not used/sprite-lab-previous-builds-2026-10-15'
Set-Location -LiteralPath $repo
$models=Get-Content docs/audits/2026-10-15/release-exe-models-final.json -Raw | ConvertFrom-Json
$desktop=Get-Content docs/audits/2026-10-15/release-final-desktop.json -Raw | ConvertFrom-Json
$ui=Get-Content docs/audits/2026-10-15/release-final-ui.json -Raw | ConvertFrom-Json
if(-not $models.ok -or -not $desktop.ok -or ($ui | Where-Object exit -ne 0)){throw 'Release diagnostics not accepted'}
$verified=Get-Content docs/audits/2026-10-15/release-verify-final.txt -Raw
if($verified -notmatch 'pass 510' -or $verified -notmatch 'fail 0' -or $verified -notmatch 'skipped 0'){throw 'Final verify did not pass'}
if(Get-Process 'Chuba Sprite Lab' -ErrorAction SilentlyContinue){throw 'Sprite Lab is still running; cleanup stopped'}
$report=[ordered]@{deleted=@();archived=@();shortcuts=@();deletedBytes=[long]0;artifact=@{}}
function Assert-Child([string]$item,[string]$root){
  $full=[IO.Path]::GetFullPath($item)
  $prefix=[IO.Path]::GetFullPath($root).TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar
  if(-not $full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw "Unsafe target: $full"}
  if(Test-Path -LiteralPath $full){
    $node=Get-Item -LiteralPath $full -Force
    if($node.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Reparse target: $full"}
  }
  return $full
}
function Remove-Owned([string]$item,[string]$root){
  $full=Assert-Child $item $root
  if(-not (Test-Path -LiteralPath $full)){return}
  $node=Get-Item -LiteralPath $full -Force
  $bytes=if($node.PSIsContainer){[long](Get-ChildItem -LiteralPath $full -File -Recurse -Force | Measure-Object Length -Sum).Sum}else{$node.Length}
  Remove-Item -LiteralPath $full -Recurse -Force
  $report.deleted+=@{path=$full;bytes=$bytes};$report.deletedBytes+=$bytes
}
function Archive-Old([string]$item,[string]$root,[string]$label){
  $full=Assert-Child $item $root
  if(-not (Test-Path -LiteralPath $full)){return}
  $destination=Assert-Child (Join-Path $backup $label) $backup
  if(Test-Path -LiteralPath $destination){throw "Archive exists: $destination"}
  Move-Item -LiteralPath $full -Destination $destination
  $report.archived+=@{from=$full;to=$destination}
}
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$exe=(Resolve-Path 'portable/Chuba Sprite Lab.exe').Path
$report.artifact=@{version='1.9.0';path=$exe;bytes=(Get-Item -LiteralPath $exe).Length;sha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLower()}
$w=New-Object -ComObject WScript.Shell
foreach($link in @('C:/Users/User/Desktop/Sprite Lab.lnk','C:/Users/User/Documents/ChatGPT/lab/Sprite Lab.lnk')){
  $shortcut=$w.CreateShortcut($link);$shortcut.TargetPath=$exe;$shortcut.WorkingDirectory=$repo;$shortcut.Arguments='';$shortcut.IconLocation="$exe,0";$shortcut.Save()
  if($w.CreateShortcut($link).TargetPath -ne $exe){throw "Shortcut verification failed: $link"}
  $report.shortcuts+=$link
}
foreach($old in @('Chuba Sprite Lab 1.8.2.exe','Chuba Sprite Lab 1.8.2 - UI fixes.exe')){Archive-Old (Join-Path (Split-Path $repo) $old) (Split-Path $repo) $old}
foreach($directory in @(Get-ChildItem -LiteralPath "$repo/.build-archive" -Directory)){
  $files=@(Get-ChildItem -LiteralPath $directory.FullName -File)
  $digest=''
  if($files.Count -eq 1 -and $files[0].Name -eq 'Chuba Sprite Lab.exe'){
    $stream=[IO.File]::OpenRead($files[0].FullName)
    try{$null=$stream.Seek(-88,[IO.SeekOrigin]::End);$footer=New-Object byte[] 88;$read=$stream.Read($footer,0,88);if($read -eq 88 -and [Text.Encoding]::ASCII.GetString($footer,0,8) -eq 'CHUBASFX'){$digest=([BitConverter]::ToString($footer,56,12)).Replace('-','').ToLower()}}finally{$stream.Dispose()}
  }
  if($digest -eq '7697dad7a5d3bf9f2b3f471a'){Remove-Owned $directory.FullName $repo}else{Archive-Old $directory.FullName $repo $directory.Name}
}
Remove-Owned "$repo/.build-archive" $repo
Remove-Owned "$repo/.build" $repo
Copy-Item -LiteralPath "$repo/docs/audits/2026-10-15/release-real-output/pig-toonout.png" -Destination "$repo/docs/audits/2026-10-15/release-pig-cut.png"
foreach($folder in @('fixture-spritelab','release-real-output','stage2-output','stage4-a-spritelab','stage5-pale-spritelab','stage6-direct-out','stage6-queue-out','timing-output','timing-shaped-output','timing-shaped-spritelab')){Remove-Owned "$repo/docs/audits/2026-10-15/$folder" $repo}
foreach($folder in @(Get-ChildItem -LiteralPath $tempRoot -Directory -Filter 'sprite-release-*')){Remove-Owned $folder.FullName $tempRoot}
Remove-Owned "$cacheRoot/7697dad7a5d3bf9f2b3f471a" $cacheRoot
$report | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath "$repo/docs/audits/2026-10-15/release-cleanup.json" -Encoding utf8
Write-Output ($report | ConvertTo-Json -Depth 7)
