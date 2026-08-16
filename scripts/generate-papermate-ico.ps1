param(
    [string]$SourcePng = (Join-Path $PSScriptRoot "..\papermate.png"),
    [string]$OutputIco = (Join-Path $PSScriptRoot "..\papermate.ico")
)

Add-Type -AssemblyName System.Drawing

$sourcePath = (Resolve-Path -LiteralPath $SourcePng).Path
$outputPath = [System.IO.Path]::GetFullPath($OutputIco)
$sizes = @(16, 24, 32, 48, 64, 128, 256)

$source = [System.Drawing.Image]::FromFile($sourcePath)
$pngBuffers = [System.Collections.Generic.List[byte[]]]::new()

try {
    foreach ($size in $sizes) {
        $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $stream = New-Object System.IO.MemoryStream

        try {
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $graphics.DrawImage($source, 0, 0, $size, $size)
            $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
            $pngBuffers.Add($stream.ToArray())
        }
        finally {
            $graphics.Dispose()
            $bitmap.Dispose()
            $stream.Dispose()
        }
    }
}
finally {
    $source.Dispose()
}

$count = $pngBuffers.Count
$header = New-Object byte[] 6
[System.BitConverter]::GetBytes([uint16]0).CopyTo($header, 0)
[System.BitConverter]::GetBytes([uint16]1).CopyTo($header, 2)
[System.BitConverter]::GetBytes([uint16]$count).CopyTo($header, 4)

$entries = New-Object byte[] ($count * 16)
$offset = 6 + $entries.Length

for ($index = 0; $index -lt $count; $index++) {
    $entryOffset = $index * 16
    $size = $sizes[$index]
    $dimension = if ($size -ge 256) { 0 } else { [byte]$size }
    $entries[$entryOffset] = $dimension
    $entries[$entryOffset + 1] = $dimension
    $entries[$entryOffset + 2] = 0
    $entries[$entryOffset + 3] = 0
    [System.BitConverter]::GetBytes([uint16]1).CopyTo($entries, $entryOffset + 4)
    [System.BitConverter]::GetBytes([uint16]32).CopyTo($entries, $entryOffset + 6)
    [System.BitConverter]::GetBytes([uint32]$pngBuffers[$index].Length).CopyTo($entries, $entryOffset + 8)
    [System.BitConverter]::GetBytes([uint32]$offset).CopyTo($entries, $entryOffset + 12)
    $offset += $pngBuffers[$index].Length
}

$fileStream = [System.IO.File]::Open($outputPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
try {
    $fileStream.Write($header, 0, $header.Length)
    $fileStream.Write($entries, 0, $entries.Length)
    foreach ($buffer in $pngBuffers) {
        $fileStream.Write($buffer, 0, $buffer.Length)
    }
}
finally {
    $fileStream.Dispose()
}

Write-Host "Created $outputPath"
