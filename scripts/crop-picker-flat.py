# 裁出深色弹窗并做扁平化处理（圆角 + 1px 描边，不投阴影）。
# 边界来自 shot-picker-dark.mjs 存下的 geo.json（弹窗内控件并集），不靠目测。
import json
import sys
from PIL import Image, ImageDraw

src = sys.argv[1]
geo_path = sys.argv[2]
dst = sys.argv[3]
S = 2   # deviceScaleFactor

g = json.load(open(geo_path, encoding='utf-8'))
im = Image.open(src)
box = (int(g['x'] * S), int(g['y'] * S), int((g['x'] + g['w']) * S), int((g['y'] + g['h']) * S))
crop = im.crop(box)
print('crop @2x:', crop.size)

out = crop.resize((crop.width // S, crop.height // S), Image.LANCZOS)

radius = 12
mask = Image.new('L', out.size, 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, out.size[0] - 1, out.size[1] - 1], radius=radius, fill=255)
canvas = Image.new('RGB', out.size, (13, 13, 17))
canvas.paste(out, (0, 0), mask)
ImageDraw.Draw(canvas).rounded_rectangle([0, 0, out.size[0] - 1, out.size[1] - 1],
                                         radius=radius, outline=(58, 58, 72), width=1)
canvas.save(dst, optimize=True)
print(f'最终 {dst} {canvas.size}')

# 对称性与内容自检
gray = canvas.convert('L')
px = gray.load()
W, H = gray.size
lo, hi = gray.getextrema()
print(f'亮度范围 {lo}..{hi} (跨度 {hi - lo})')
if hi - lo < 20:
    print('!! 几乎单色，可能裁到空白')
    sys.exit(1)


def edge(xs):
    vals = []
    for xx in xs:
        s = n = 0
        for y in range(int(H * 0.10), int(H * 0.90)):
            s += px[xx, y]
            n += 1
        vals.append(s / max(n, 1))
    return sum(vals) / len(vals)


l, r = edge([1, 2, 3]), edge([W - 2, W - 3, W - 4])
print(f'左缘 {l:.1f}  右缘 {r:.1f}  差 {abs(l - r):.1f} ' + ('(对称)' if abs(l - r) < 5 else '(不对称!)'))
