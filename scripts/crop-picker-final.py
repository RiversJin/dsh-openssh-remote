# 裁出弹窗（用容器边界 + 留白），做扁平化，并自检边缘不切字。
import json
import sys
from PIL import Image, ImageDraw

src, geo_path, dst = sys.argv[1], sys.argv[2], sys.argv[3]
S = 2

g = json.load(open(geo_path, encoding='utf-8'))
d, pad = g['dialog'], g['pad']
x0, y0 = d['x'] - pad, d['y'] - pad
w, h = d['w'] + 2 * pad, d['h'] + 2 * pad

im = Image.open(src)
crop = im.crop((int(x0 * S), int(y0 * S), int((x0 + w) * S), int((y0 + h) * S)))
print('crop @2x:', crop.size)
out = crop.resize((crop.width // S, crop.height // S), Image.LANCZOS)

radius = 14
mask = Image.new('L', out.size, 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, out.size[0] - 1, out.size[1] - 1], radius=radius, fill=255)
final = Image.new('RGB', out.size, (13, 13, 17))
final.paste(out, (0, 0), mask)
ImageDraw.Draw(final).rounded_rectangle([0, 0, out.size[0] - 1, out.size[1] - 1],
                                        radius=radius, outline=(58, 58, 72), width=1)
final.save(dst, optimize=True)
print(f'最终 {dst} {final.size}')

# 自检：四边 6px 内不应有高亮文字像素
gray = final.convert('L')
px = gray.load()
W, H = gray.size
INK = 110
corner = radius + 2
bad = {}
for edge, coords in {
    'left': [(x, y) for y in range(corner, H - corner) for x in range(6)],
    'right': [(W - 1 - x, y) for y in range(corner, H - corner) for x in range(6)],
    'top': [(x, y) for x in range(corner, W - corner) for y in range(6)],
    'bottom': [(x, H - 1 - y) for x in range(corner, W - corner) for y in range(6)],
}.items():
    bad[edge] = sum(1 for (x, y) in coords if px[x, y] >= INK)
print('边缘高亮像素(应为 0):', bad)

lo, hi = gray.getextrema()
print(f'亮度范围 {lo}..{hi}')
if any(bad.values()):
    print('!! 边缘仍有切断')
    sys.exit(1)
print('边缘自检通过')
