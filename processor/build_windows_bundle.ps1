param(
  [string]$OutputDir = (Join-Path $PSScriptRoot "..\desktop\resources\processor"),
  [string]$PythonCommand = $env:KARAOKEAI_BUNDLE_PYTHON
)

$ErrorActionPreference = "Stop"

$processorRoot = $PSScriptRoot
$buildRoot = Join-Path $processorRoot ".pyinstaller"
$distRoot = Join-Path $buildRoot "dist"
$workRoot = Join-Path $buildRoot "work"
$specRoot = Join-Path $buildRoot "spec"
if (-not $PythonCommand) {
  $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { "" }
  $localProcessorPython = Join-Path $localAppData "KaraokeAI\processor-env\Scripts\python.exe"
  if ($env:LOCALAPPDATA -and (Test-Path $localProcessorPython)) {
    $PythonCommand = $localProcessorPython
  }
}

if (-not $PythonCommand) {
  $PythonCommand = "python"
}

Write-Host "Preparing KaraokeAI processor bundle..."
Write-Host "Processor root: $processorRoot"
Write-Host "Output dir: $OutputDir"
Write-Host "Python: $PythonCommand"

if (Test-Path $OutputDir) {
  Remove-Item -LiteralPath $OutputDir -Recurse -Force
}

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
New-Item -ItemType Directory -Path $specRoot -Force | Out-Null
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$ffmpegPath = & $PythonCommand -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"
if (-not $ffmpegPath) {
  throw "Unable to resolve bundled FFmpeg from imageio-ffmpeg."
}

& $PythonCommand -m PyInstaller `
  --noconfirm `
  --clean `
  --onedir `
  --name karaoke-processor `
  --distpath $distRoot `
  --workpath $workRoot `
  --specpath $specRoot `
  --paths $processorRoot `
  --collect-all demucs `
  --collect-all faster_whisper `
  --collect-all ctranslate2 `
  --collect-all imageio_ffmpeg `
  --collect-all openunmix `
  --collect-all julius `
  --collect-all dora `
  --collect-all omegaconf `
  --collect-all av `
  (Join-Path $processorRoot "entrypoint.py")

$builtBundle = Join-Path $distRoot "karaoke-processor"
if (-not (Test-Path $builtBundle)) {
  throw "PyInstaller did not produce the expected processor bundle."
}

Copy-Item -Path (Join-Path $builtBundle "*") -Destination $OutputDir -Recurse -Force
Copy-Item -LiteralPath $ffmpegPath -Destination (Join-Path $OutputDir "ffmpeg.exe") -Force

Write-Host "Processor bundle ready at $OutputDir"
