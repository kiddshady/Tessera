"""Genera el ícono de Tessera: build/icon.png (256) y build/icon.ico (16…256).

La misma marca del splash y la titlebar — la tesela redondeada con el arco del
tiempo — sobre una baldosa oscura que llega a sangre, sin margen ni borde:
el ícono ES la baldosa. Se dibuja a 4× y se baja con Lanczos para que el trazo
quede limpio en los tamaños chicos.

    python tools/icon.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "build"
S = 256          # tamaño base
SS = 4           # supermuestreo
N = S * SS

TILE = (16, 18, 22, 255)      # la baldosa: un paso más clara que el fondo de la app (#0a0b0d)
INK = (242, 244, 247, 255)    # el trazo, el mismo --ox-text
INK_DIM = (242, 244, 247, 190)

def u(v):
    """Unidades de la grilla de 16 del SVG → píxeles del lienzo supermuestreado."""
    return v * N / 16

img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# La baldosa, a sangre, con el radio de las apps de Windows 11 (~22 %).
d.rounded_rectangle((0, 0, N - 1, N - 1), radius=int(N * 0.22), fill=TILE)

# La tesela: el mismo rounded-rect del SVG (2.4…13.6, r=2.8), un poco más
# chico para que respire dentro de la baldosa.
w = u(1.15)                                  # grosor del trazo
box = (u(3.35), u(3.35), u(12.65), u(12.65))
d.rounded_rectangle(box, radius=u(2.3), outline=INK, width=int(w))

# El arco del tiempo: 270° en sentido horario desde arriba, como el SVG
# (M8 4.8 A3.2 3.2 0 1 1 4.8 8), apenas más chico por la escala de la tesela.
r = u(2.65)
cx = cy = u(8)
d.arc((cx - r, cy - r, cx + r, cy + r), start=270, end=180, fill=INK_DIM, width=int(w))

base = img.resize((S, S), Image.LANCZOS)
OUT.mkdir(exist_ok=True)
base.save(OUT / "icon.png")
base.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(f"{OUT / 'icon.png'}\n{OUT / 'icon.ico'}")
