# Renders the project's own geometric icon; no third-party image assets.
Add-Type -AssemblyName System.Drawing
$repoDirectory = Split-Path -Parent $PSScriptRoot
$bitmap = [System.Drawing.Bitmap]::new(256,256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$background = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#102b3b'))
$body = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#187b89'))
$top = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#245167'))
$outline = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#67e0cf'),9)
$brackets = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#e9f4f3'),9)
$brackets.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$brackets.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$brackets.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
try {
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $backgroundPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
  try {
    $backgroundPath.AddArc(0,0,96,96,180,90)
    $backgroundPath.AddArc(160,0,96,96,270,90)
    $backgroundPath.AddArc(160,160,96,96,0,90)
    $backgroundPath.AddArc(0,160,96,96,90,90)
    $backgroundPath.CloseFigure()
    $graphics.FillPath($background,$backgroundPath)
  } finally { $backgroundPath.Dispose() }
  $graphics.FillRectangle($body,76,84,104,88)
  $graphics.FillEllipse($body,76,152,104,40)
  $graphics.DrawLine($outline,76,84,76,172)
  $graphics.DrawLine($outline,180,84,180,172)
  $graphics.DrawArc($outline,76,152,104,40,0,180)
  $graphics.DrawArc($outline,76,106,104,40,0,180)
  $graphics.DrawArc($outline,76,140,104,40,0,180)
  $graphics.FillEllipse($top,76,64,104,40)
  $graphics.DrawEllipse($outline,76,64,104,40)
  $graphics.DrawLines($brackets,[System.Drawing.Point[]]@([System.Drawing.Point]::new(48,104),[System.Drawing.Point]::new(30,128),[System.Drawing.Point]::new(48,152)))
  $graphics.DrawLines($brackets,[System.Drawing.Point[]]@([System.Drawing.Point]::new(208,104),[System.Drawing.Point]::new(226,128),[System.Drawing.Point]::new(208,152)))
  $bitmap.Save((Join-Path $repoDirectory 'media/icon.png'),[System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose(); $bitmap.Dispose(); $background.Dispose(); $body.Dispose(); $top.Dispose(); $outline.Dispose(); $brackets.Dispose()
}
