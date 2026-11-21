param([Parameter(Mandatory=$true)][string]$Records)
$ErrorActionPreference='Stop'
chcp 65001 > $null
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$rows=Get-Content -LiteralPath $Records -Raw -Encoding UTF8|ConvertFrom-Json
$temporaryRoot=(Resolve-Path -LiteralPath $env:TEMP).Path.TrimEnd('\')+'\'
$directory=Join-Path $temporaryRoot ('nxbridge-language-check-'+[Guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $directory
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$flags=[Reflection.BindingFlags]'Public,NonPublic,Instance,Static,DeclaredOnly'
function Assembly-IL($assembly) {
  $result=[ordered]@{}
  foreach($type in @($assembly.GetTypes()|Sort-Object FullName)){
    $members=@($type.GetMethods($flags))+@($type.GetConstructors($flags))
    if($type.TypeInitializer){$members+=,$type.TypeInitializer}
    foreach($method in @($members|Sort-Object { $_.ToString() })){
      $body=$method.GetMethodBody()
      $result[$type.FullName+'::'+$method.ToString()]=$(if($body){[Convert]::ToBase64String($body.GetILAsByteArray())}else{'native'})
    }
  }
  return ($result|ConvertTo-Json -Depth 40 -Compress)
}
function Value-Shape($value) {
  if($null -eq $value){return 'null'}
  if($value -is [Management.Automation.Language.Ast]){return 'ast:'+$value.GetType().FullName}
  if($value -is [Management.Automation.Language.IScriptExtent]){return 'extent'}
  if($value -is [type]){return 'type:'+$value.FullName}
  if($value -is [Management.Automation.VariablePath]){return 'variable:'+$value.UserPath}
  if($value -is [Management.Automation.Language.ITypeName]){return 'typename:'+$value.FullName}
  if($value -is [string] -or $value.GetType().IsPrimitive -or $value.GetType().IsEnum){return (($value.GetType().FullName+':'+[string]$value)|ConvertTo-Json -Compress)}
  if($value -is [Collections.IEnumerable]){return '['+((@($value|ForEach-Object {Value-Shape $_})) -join ',')+']'}
  if($value.GetType().FullName.StartsWith('System.Tuple')){return 'tuple('+((@($value.PSObject.Properties|Where-Object Name -Like 'Item*'|ForEach-Object {Value-Shape $_.Value})) -join ',')+')'}
  return $value.GetType().FullName+':'+[string]$value
}
function Powershell-AST($source) {
  $tokens=$null;$errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
  if($errors.Count){throw ('PowerShell 语法错误：'+(($errors|ForEach-Object Message) -join '；'))}
  $nodes=@($ast.FindAll({param($node) $true},$true)|ForEach-Object {
    $properties=[ordered]@{type=$_.GetType().FullName}
    foreach($property in @($_.PSObject.Properties|Sort-Object Name)){
      if($property.Name -notin @('Parent','Extent','StaticType')){$properties[$property.Name]=Value-Shape $property.Value}
    }
    $properties
  })
  return ($nodes|ConvertTo-Json -Depth 80 -Compress)
}
try {
  $index=0;$csharp=0;$powershell=0
  foreach($row in @($rows|Where-Object language -EQ 'csharp')){
    $assemblies=@();$times=@()
    foreach($kind in @('original','compact')){
      $source=Join-Path $directory ($index.ToString()+'-'+$kind+'.cs')
      $output=Join-Path $directory ($index.ToString()+'-'+$kind+'.dll')
      [IO.File]::WriteAllText($source,[string]$row.$kind,[Text.UTF8Encoding]::new($false))
      $watch=[Diagnostics.Stopwatch]::StartNew()
      $diagnostic=& $compiler /nologo /target:library /optimize+ ('/out:'+$output) $source 2>&1
      if($LASTEXITCODE -ne 0){throw ('C# 编译失败：'+$row.file+'；'+($diagnostic -join [Environment]::NewLine))}
      $watch.Stop();$times+=,$watch.Elapsed.TotalMilliseconds
      $assemblies+=,[Reflection.Assembly]::Load([IO.File]::ReadAllBytes($output))
    }
    if((Assembly-IL $assemblies[0]) -cne (Assembly-IL $assemblies[1])){throw ('C# IL 不同：'+$row.file)}
    [Console]::WriteLine((@{language='csharp';file=$row.file;IL='equal';compileOriginalMs=$times[0];compileCompactMs=$times[1]}|ConvertTo-Json -Compress))
    $index++;$csharp++
  }
  foreach($row in @($rows|Where-Object language -EQ 'powershell')){
                                               
    $before=[regex]::Replace($row.original,'__NXBRIDGE_EMBED_HOLE_\d+__','1')
    $after=[regex]::Replace($row.compact,'__NXBRIDGE_EMBED_HOLE_\d+__','1')
    if((Powershell-AST $before) -cne (Powershell-AST $after)){throw ('PowerShell AST 不同：'+$row.file+':'+$row.line)}
    $powershell++
  }
  [Console]::WriteLine((@{validation='PASS';csharp=$csharp;powershell=$powershell}|ConvertTo-Json -Compress))
} finally {
  $resolved=(Resolve-Path -LiteralPath $directory).Path
  if(!$resolved.StartsWith($temporaryRoot,[StringComparison]::OrdinalIgnoreCase)){throw '语言检查目录越界。'}
  Remove-Item -LiteralPath $resolved -Recurse -ErrorAction Stop
}
