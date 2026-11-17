# PII Shield v2 - GLiNER model installer (Windows PowerShell)
#
# Downloads the model gliner_multi_pii-v1 (~1.1 GB, ONNX) from Hugging Face into
# $HOME\.pii_shield\models\gliner_multi_pii-v1\ so the PII Shield .mcpb plugin can find it at runtime.
#
# Model: gliner_multi_pii-v1 by Urchade (Apache License 2.0), https://huggingface.co/urchade/gliner_multi_pii-v1
# ONNX conversion: onnx-community, https://huggingface.co/onnx-community/gliner_multi_pii-v1
# The files are downloaded at a fixed revision of that repository and checked against the SHA-256 values below.
# If a file does not match, nothing is installed.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install-model.ps1
#   (or ask Claude: "install the PII Shield model" - it can run this script)
#
# Idempotent: safe to re-run. If every file is already installed and matches, nothing is downloaded.
#
# IMPORTANT FOR MAINTAINERS: this file must stay pure ASCII (no em-dashes,
# no smart quotes). Windows PowerShell 5.1 reads .ps1 files via the system
# ANSI codepage when there is no UTF-8 BOM; non-ASCII bytes corrupt the
# token stream and surface as confusing "Unexpected token" errors on
# totally unrelated lines.
$ErrorActionPreference = "Stop"
$MODEL_SLUG = "gliner_multi_pii-v1"
$REPO = "onnx-community/gliner_multi_pii-v1"
$REVISION = "2e0397a7e8a250d76c37122232b3cbde42c8d629"
$BASE_URL = "https://huggingface.co/$REPO/resolve/$REVISION"
$MODELS_DIR = Join-Path $HOME ".pii_shield\models"
$TARGET = Join-Path $MODELS_DIR $MODEL_SLUG
# Remote path, local name, SHA-256 (lower case)
$FILES = @(
    @{ Remote = "onnx/model.onnx"; Name = "model.onnx"; Sha = "7704865e414f24591da6aee08716a25677855bc8a84af81396d90e40df1e68d2" },
    @{ Remote = "tokenizer.json"; Name = "tokenizer.json"; Sha = "914bd3c8fb7b525af9e23b60d0ec7b1248ddb2b99014efd9c02ebeb022f8cab7" },
    @{ Remote = "tokenizer_config.json"; Name = "tokenizer_config.json"; Sha = "78f866883daf7ee2bc400200a155cdbe9116ed0a6ed597ff573ea2c9862a89a6" },
    @{ Remote = "gliner_config.json"; Name = "gliner_config.json"; Sha = "69e141f7fe1864e0d81ab0e542c68387d588db62393bcd93b471d54dcf0f5c16" },
    @{ Remote = "special_tokens_map.json"; Name = "special_tokens_map.json"; Sha = "9463f61e1b109a8eb4688b829260d7c6b1e6dff04c98ff7269bb89e2b92369b9" },
    @{ Remote = "added_tokens.json"; Name = "added_tokens.json"; Sha = "030e747c4ca7992a3ac794c6fda9919352c88ae722e85178217cd083b450078d" }
)
$NOTICE = @"
gliner_multi_pii-v1
Model: gliner_multi_pii-v1, author Urchade (https://huggingface.co/urchade/gliner_multi_pii-v1), Apache License 2.0
(https://www.apache.org/licenses/LICENSE-2.0).
ONNX conversion: $REPO (https://huggingface.co/$REPO), revision $REVISION, files unchanged.
"@
# Custom downloader using System.Net.Http.HttpClient. Built-in
# Invoke-WebRequest in Windows PowerShell 5.1 redraws its progress bar by
# repainting the entire console window per chunk - on a 1 GB file that means
# a 5x slowdown AND a flickery UX. The HttpClient path lets us throttle the
# redraw to ~5x/sec and show percent + MB/total + MB/s + ETA in a single line.
Add-Type -AssemblyName System.Net.Http | Out-Null
function Download-WithProgress {
    param(
        [Parameter(Mandatory)] [string] $Uri,
        [Parameter(Mandatory)] [string] $OutFile,
        [Parameter(Mandatory)] [string] $DisplayName
    )
    $client = [System.Net.Http.HttpClient]::new()
    try {
        $client.Timeout = [TimeSpan]::FromMinutes(30)
        $response = $client.GetAsync(
            $Uri,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
        ).GetAwaiter().GetResult()
        $response.EnsureSuccessStatusCode() | Out-Null
        $totalBytes = $null
        if ($response.Content.Headers.ContentLength) {
            $totalBytes = [long]$response.Content.Headers.ContentLength
        }
        $totalMb = if ($totalBytes) { [math]::Round($totalBytes / 1MB, 1) } else { $null }
        $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $fs = [System.IO.File]::Create($OutFile)
        $buffer = New-Object byte[] (1MB)
        [long]$totalRead = 0
        $startTime = Get-Date
        $lastPrintTime = $startTime
        try {
            while ($true) {
                $bytesRead = $stream.Read($buffer, 0, $buffer.Length)
                if ($bytesRead -le 0) { break }
                $fs.Write($buffer, 0, $bytesRead)
                $totalRead += $bytesRead
                $now = Get-Date
                $msSinceLast = ($now - $lastPrintTime).TotalMilliseconds
                if ($msSinceLast -lt 200) { continue }
                $elapsed = ($now - $startTime).TotalSeconds
                $mb = [math]::Round($totalRead / 1MB, 1)
                $speedMbs = if ($elapsed -gt 0) {
                    [math]::Round(($totalRead / 1MB) / $elapsed, 2)
                } else { 0 }
                if ($totalBytes) {
                    $pct = [int](($totalRead / $totalBytes) * 100)
                    $remainingMb = ($totalBytes - $totalRead) / 1MB
                    $etaStr = if ($speedMbs -gt 0) {
                        $sec = [int]($remainingMb / $speedMbs)
                        "{0:00}:{1:00}" -f ([int]($sec / 60)), ($sec % 60)
                    } else { "--:--" }
                    $line = "    {0}: {1,3}% ({2,7:N1} / {3,7:N1} MB) {4,5:N2} MB/s ETA {5}" -f `
                        $DisplayName, $pct, $mb, $totalMb, $speedMbs, $etaStr
                } else {
                    $line = "    {0}: {1,7:N1} MB ({2,5:N2} MB/s)" -f `
                        $DisplayName, $mb, $speedMbs
                }
                # \r returns to start of line; trailing spaces overwrite any
                # leftover characters from a previous (longer) line.
                Write-Host -NoNewline ("`r" + $line + "          ")
                $lastPrintTime = $now
            }
            # Final summary line - overwrite the in-place progress.
            $finalMb = [math]::Round($totalRead / 1MB, 1)
            $totalSec = ((Get-Date) - $startTime).TotalSeconds
            $avgSpeed = if ($totalSec -gt 0) {
                [math]::Round(($totalRead / 1MB) / $totalSec, 2)
            } else { 0 }
            $minutes = [int]($totalSec / 60)
            $seconds = $totalSec - ($minutes * 60)
            $timeStr = if ($minutes -gt 0) {
                "{0}m{1:N0}s" -f $minutes, $seconds
            } else {
                "{0:N1}s" -f $totalSec
            }
            Write-Host ("`r    {0}: done {1,7:N1} MB in {2} (avg {3:N2} MB/s)                              " -f `
                $DisplayName, $finalMb, $timeStr, $avgSpeed)
        }
        finally {
            $fs.Close()
            $stream.Close()
        }
    }
    finally {
        $client.Dispose()
    }
}
function Get-Sha256 {
    param([Parameter(Mandatory)] [string] $Path)
    return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
}
Write-Host ""
Write-Host "PII Shield - installing the model gliner_multi_pii-v1 (~1.1 GB)"
Write-Host "  Source: https://huggingface.co/$REPO (revision $REVISION)"
Write-Host "  Target: $TARGET"
Write-Host ""
# Already installed and intact: nothing to do.
$allThere = $true
foreach ($f in $FILES) {
    $p = Join-Path $TARGET $f.Name
    if (-not (Test-Path $p) -or (Get-Sha256 -Path $p) -ne $f.Sha) { $allThere = $false; break }
}
if ($allThere) {
    Write-Host "[OK] Model already installed and verified at $TARGET" -ForegroundColor Green
    Write-Host ""
    exit 0
}
New-Item -ItemType Directory -Force -Path $MODELS_DIR | Out-Null
$staging = Join-Path $MODELS_DIR (".$MODEL_SLUG.partial-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $staging | Out-Null
$overallStart = Get-Date
try {
    $i = 0
    foreach ($f in $FILES) {
        $i++
        Write-Host ("{0}/{1} {2}" -f $i, $FILES.Count, $f.Name)
        $dest = Join-Path $staging $f.Name
        Download-WithProgress -Uri "$BASE_URL/$($f.Remote)" -OutFile $dest -DisplayName $f.Name
        $got = Get-Sha256 -Path $dest
        if ($got -ne $f.Sha) {
            Write-Host ""
            Write-Host "ERROR: $($f.Name) does not match the expected SHA-256." -ForegroundColor Red
            Write-Host "  expected $($f.Sha)" -ForegroundColor Red
            Write-Host "  got      $got" -ForegroundColor Red
            Write-Host "Nothing was installed. Re-run this script; if it fails again, the file on Hugging Face has changed." -ForegroundColor Red
            exit 1
        }
    }
    Set-Content -Path (Join-Path $staging "NOTICE.txt") -Value $NOTICE -Encoding UTF8
    if (Test-Path $TARGET) { Remove-Item -Recurse -Force $TARGET }
    Move-Item -Path $staging -Destination $TARGET
} finally {
    if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
}
$overallSec = ((Get-Date) - $overallStart).TotalSeconds
$modelMb = [math]::Round((Get-Item (Join-Path $TARGET "model.onnx")).Length / 1MB, 1)
$overallMin = [int]($overallSec / 60)
$overallRemSec = $overallSec - ($overallMin * 60)
$overallTimeStr = if ($overallMin -gt 0) {
    "{0}m{1:N0}s" -f $overallMin, $overallRemSec
} else {
    "{0:N1}s" -f $overallSec
}
Write-Host ""
Write-Host "[OK] Model installed at $TARGET ($modelMb MB, total time $overallTimeStr)" -ForegroundColor Green
Write-Host ""
Write-Host "Next step: install the PII Shield .mcpb plugin in Claude Desktop"
Write-Host "(Settings -> Extensions -> drag-drop), then restart Claude Desktop."
Write-Host ""
