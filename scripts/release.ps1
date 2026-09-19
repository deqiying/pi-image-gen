#Requires -Version 7.0
<#
.SYNOPSIS
    同步插件版本号，创建发布提交和本地 tag，不自动推送。
.DESCRIPTION
    同步 package.json、package-lock.json 和 manifest.json 的 version 字段。
    脚本要求工作树干净，防止把无关改动带入发布提交。
.EXAMPLE
    pwsh -File scripts/release.ps1 0.1.1
#>
param(
    [Parameter(Position = 0)]
    [string]$Version,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArguments = @()
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
}
catch {
    # 无控制台宿主可能拒绝设置输出编码，不影响发布逻辑。
}

if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$usage = "用法: pwsh -File scripts/release.ps1 <semver>   例: pwsh -File scripts/release.ps1 0.1.1"
$versionPattern = '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
$versionFiles = @("package.json", "package-lock.json", "manifest.json")

if ([string]::IsNullOrWhiteSpace($Version) -or $ExtraArguments.Count -gt 0) {
    throw $usage
}
if ($Version -notmatch $versionPattern) {
    throw "版本号不是合法 semver: $Version$([Environment]::NewLine)$usage"
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath $($Arguments -join ' ') 失败，退出码 $LASTEXITCODE"
    }
}

function Get-CheckedOutput {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    $output = & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath $($Arguments -join ' ') 失败，退出码 $LASTEXITCODE"
    }
    return $output
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Content
    )

    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tagName = "v$Version"
$manifestUpdateScript = @'
import fs from "node:fs";
const version = process.argv[1];
const path = "manifest.json";
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
manifest.version = version;
fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
'@

Push-Location $repoRoot
try {
    $currentVersion = (Get-Content -LiteralPath "package.json" -Raw | ConvertFrom-Json).version
    if ($Version -eq $currentVersion) {
        throw "package.json 版本已是 $currentVersion，未做修改。"
    }

    $currentCore = ($currentVersion -split '[-+]')[0]
    $newCore = ($Version -split '[-+]')[0]
    if ([version]$newCore -lt [version]$currentCore) {
        throw "新版本 $Version 低于当前版本 $currentVersion，拒绝降级。"
    }

    $statusLines = @(Get-CheckedOutput git @("status", "--porcelain"))
    if ($statusLines.Count -gt 0) {
        $details = ($statusLines | ForEach-Object { "  $_" }) -join [Environment]::NewLine
        throw "工作树不干净，请先提交或 stash 后再准备发布：$([Environment]::NewLine)$details"
    }

    $null = & git rev-parse -q --verify "refs/tags/$tagName" *> $null
    if ($LASTEXITCODE -eq 0) {
        throw "tag $tagName 已存在。"
    }

    $branch = (Get-CheckedOutput git @("rev-parse", "--abbrev-ref", "HEAD")).Trim()

    Invoke-Checked npm @("version", $Version, "--no-git-tag-version") *> $null
    Invoke-Checked node @("--input-type=module", "-e", $manifestUpdateScript, $Version) *> $null

    Invoke-Checked git (@("add", "--") + $versionFiles)
    & git (@("diff", "--cached", "--quiet", "--") + $versionFiles)
    if ($LASTEXITCODE -gt 1) {
        throw "git diff 失败，退出码 $LASTEXITCODE"
    }
    if ($LASTEXITCODE -eq 0) {
        throw "版本文件没有产生可提交的改动，已中止。"
    }

    $messageFile = [System.IO.Path]::GetTempFileName()
    try {
        Write-Utf8NoBom -Path $messageFile -Content "chore(release): 发布 $Version$([Environment]::NewLine)"
        Invoke-Checked git @("commit", "-F", $messageFile)
    }
    finally {
        Remove-Item -LiteralPath $messageFile -Force -ErrorAction SilentlyContinue
    }

    Invoke-Checked git @("tag", $tagName)

    Write-Host "已在 $branch 上准备发布 $Version：已提交并创建本地 tag $tagName（未推送）。"
    Write-Host "手动推送命令：git push origin $branch && git push origin $tagName"
}
finally {
    Pop-Location
}
