#!/usr/bin/env python3
"""Arma QUBO a partir de src/: una página para publicar y la carpeta lista para Hostinger."""
import pathlib, zipfile
R = pathlib.Path(__file__).parent
src = lambda n: (R / 'src' / n).read_text(encoding='utf-8')
FONTS = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600..700&family=Figtree:wght@400..700&display=swap'
css, body, core, ui = src('style.css'), src('body.html'), src('core.js'), src('ui.js')
assert 'const HOSTED = false;' in ui

# 1) Página para publicar (el visor añade <html>, <head> y <body>)
import re
ui_pub = re.sub(r'[ \t]*/\*SOLO-HOSTINGER\*/.*?/\*FIN-SOLO-HOSTINGER\*/\n', '', ui, flags=re.S)   # el visor no permite descargas
assert 'download' not in ui_pub.replace('bk-download', '')
page = f'<title>QUBO</title>\n<link rel="stylesheet" href="{FONTS}">\n<style>\n{css}</style>\n\n{body}\n<script>\n{core}</script>\n<script>\n{ui_pub}</script>\n'
(R / 'dist').mkdir(exist_ok=True)
(R / 'dist' / 'qubo.html').write_text(page, encoding='utf-8')

# 2) Carpeta para Hostinger
H = R / 'dist' / 'hostinger'; H.mkdir(exist_ok=True)
index = f'''<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>QUBO</title>
<meta name="description" content="Registra ingresos y decide qué pagar, qué reservar y qué conservar.">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#EDF0EE" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0F1513" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="QUBO">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon-192.png" type="image/png">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="{FONTS}">
<style>
{css}</style>
</head>
<body>
{body}
<script>
{core}</script>
<script>
{ui.replace('const HOSTED = false;', 'const HOSTED = true; ')}</script>
</body>
</html>
'''
(H / 'index.html').write_text(index, encoding='utf-8')
for n in ('sw.js', 'manifest.webmanifest', 'LEEME.txt', 'icon-180.png', 'icon-192.png', 'icon-512.png'):
    if (R / 'src' / n).exists(): (H / n).write_bytes((R / 'src' / n).read_bytes())
with zipfile.ZipFile(R / 'dist' / 'qubo-hostinger.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for f in sorted(H.iterdir()): z.write(f, f.name)
print('ok', {f.name: f.stat().st_size for f in sorted(H.iterdir())})
