Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 1000,440
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAliasGridFit'
function Brush($hex) { New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($hex)) }
function Rect($x,$y,$w,$h,$c) { $b=Brush $c; $g.FillRectangle($b,$x,$y,$w,$h); $b.Dispose() }
function Text($s,$x,$y,$size,$c) { $f=New-Object System.Drawing.Font('Segoe UI',$size,[System.Drawing.FontStyle]::Regular); $b=Brush $c; $g.DrawString($s,$f,$b,$x,$y); $f.Dispose(); $b.Dispose() }
function Icon($x,$y,$open) { $p=New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#a1a1aa')),1.7; $g.DrawRectangle($p,$x,$y,20,17); $g.DrawLine($p,$x+7,$y,$x+7,$y+17); if($open) { $g.DrawLine($p,$x+11,$y+5,$x+15,$y+9); $g.DrawLine($p,$x+15,$y+9,$x+11,$y+13) } else { $g.DrawLine($p,$x+16,$y+5,$x+12,$y+9); $g.DrawLine($p,$x+12,$y+9,$x+16,$y+13) }; $p.Dispose() }
$g.Clear([System.Drawing.ColorTranslator]::FromHtml('#19191d'))
Text 'EXPANDED' 35 22 11 '#a1a1aa'
Text 'COLLAPSED' 555 22 11 '#a1a1aa'
Rect 35 62 455 305 '#111113'
Rect 35 62 285 305 '#09090b'
Rect 320 62 1 305 '#2a2a2e'
Rect 51 79 32 32 '#43c5ef'
Text 'TD' 55 83 12 '#071013'
Text 'Test Data Lab' 94 82 14 '#ededee'
Icon 281 86 $false
Rect 47 136 260 43 '#232327'
Text '▦' 58 144 15 '#ededee'
Text 'Dashboard' 93 145 12 '#ededee'
Text '⌕' 58 198 17 '#a1a1aa'
Text 'Explorer' 93 199 12 '#a1a1aa'
Text '⚙' 58 252 15 '#a1a1aa'
Text 'Settings' 93 253 12 '#a1a1aa'
Text 'Dashboard' 342 85 14 '#ededee'
Rect 555 62 410 305 '#111113'
Rect 555 62 64 305 '#09090b'
Rect 619 62 1 305 '#2a2a2e'
Icon 577 86 $true
Rect 565 136 44 43 '#232327'
Text '▦' 575 144 15 '#ededee'
Text '⌕' 575 198 17 '#a1a1aa'
Text '⚙' 575 252 15 '#a1a1aa'
Text 'Dashboard' 643 85 14 '#ededee'
Text 'One quiet control in the header. No separate collapse row.' 35 394 13 '#c4c4cb'
$bmp.Save('C:/Projects/qbo/output/sidebar-comparison.png',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
