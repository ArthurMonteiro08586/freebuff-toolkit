[CmdletBinding()]
param(
    [string]$NodeVersion = ""
)

$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $repositoryRoot "launcher\runtime"

if ([string]::IsNullOrWhiteSpace($NodeVersion)) {
    Write-Host "正在查询 Node.js 24 最新版本..."
    $releases = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
    $release = @($releases) |
        Where-Object { $_.version -match '^v24\.' -and $_.files -contains 'win-x64-zip' } |
        Select-Object -First 1

    if ($null -eq $release) {
        throw "无法找到可用的 Node.js 24 Windows x64 版本。"
    }

    $NodeVersion = [string]$release.version
}

if ($NodeVersion -notmatch '^v24\.\d+\.\d+$') {
    throw "NodeVersion 必须是 v24.x.x 格式，例如 v24.6.0。"
}

$assetName = "node-$NodeVersion-win-x64.zip"
$downloadRoot = "https://nodejs.org/dist/$NodeVersion"
$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("freebuff-node-" + [Guid]::NewGuid().ToString("N"))
$archivePath = Join-Path $temporaryDirectory $assetName
$checksumsPath = Join-Path $temporaryDirectory "SHASUMS256.txt"

New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null

try {
    Write-Host "正在下载 $assetName..."
    Invoke-WebRequest -Uri "$downloadRoot/$assetName" -OutFile $archivePath -UseBasicParsing
    Invoke-WebRequest -Uri "$downloadRoot/SHASUMS256.txt" -OutFile $checksumsPath -UseBasicParsing

    $checksumLine = Get-Content -LiteralPath $checksumsPath |
        Where-Object { $_ -match ([regex]::Escape($assetName) + '$') } |
        Select-Object -First 1

    if ([string]::IsNullOrWhiteSpace($checksumLine)) {
        throw "Node.js 校验文件中没有找到 $assetName。"
    }

    $expectedHash = (($checksumLine -split '\s+')[0]).ToUpperInvariant()
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "Node.js 压缩包 SHA-256 校验失败。"
    }

    Expand-Archive -LiteralPath $archivePath -DestinationPath $temporaryDirectory -Force
    $extractedDirectory = Join-Path $temporaryDirectory "node-$NodeVersion-win-x64"
    $nodePath = Join-Path $extractedDirectory "node.exe"
    $licensePath = Join-Path $extractedDirectory "LICENSE"

    if (-not (Test-Path -LiteralPath $nodePath) -or -not (Test-Path -LiteralPath $licensePath)) {
        throw "Node.js 压缩包内容不完整。"
    }

    Copy-Item -LiteralPath $nodePath -Destination (Join-Path $runtimeDirectory "node.exe") -Force
    Copy-Item -LiteralPath $licensePath -Destination (Join-Path $runtimeDirectory "NODE_LICENSE.txt") -Force
}
finally {
    if (Test-Path -LiteralPath $temporaryDirectory) {
        Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
    }
}

Write-Host "Node.js $NodeVersion 已准备到 launcher\runtime。"
