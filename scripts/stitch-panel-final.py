# 拼接设置面板两段截图。
#
# 边界用**滚动容器**（448,564,612x746）而不是"内容并集"（556 宽）：
# 容器本身已含内边距，按它裁出来的文字不会贴边。之前按内容并集裁，
# 结果右/上边缘切到字（用户指出"区域太窄、边界文字被切割"）。
#
# 另外：拼接后左右各多留 MARGIN px 呼吸，并在最外层用深色画布补齐圆角，
# 这样即便容器边缘有 1px 反锯齿也不会显得被切。
import json
import sys
from PIL import Image, ImageDraw

prefix = sys.argv[1]
dst = sys.argv[2]
meta = json.load(open(f'{prefix}-meta.json', encoding='utf-8'))

S = 2  # deviceScaleFactor
cx, cy, cw, ch = (meta['container'][k] for k in ('x', 'y', 'w', 'h'))
positions = meta['positions']
client_h = meta['clientH']
scroll_h = meta['scrollH']
content_top = meta['contentTop']       # 面板内容在页面坐标里的起点

# 呼吸留白
MARGIN = 14
x0 = cx - MARGIN
w = cw + 2 * MARGIN

# 每段：截图中该段可见的面板区间 = 容器在视口里的 y .. y+client_h
# 段 i 的 scrollTop = positions[i]；内容第 scrollTop 行显示在容器顶部
parts = []
for i, top in enumerate(positions):
    im = Image.open(f'{prefix}-s{i}.png')
    # 段 i 覆盖的内容区间 [top, top + client_h]
    seg_start = top
    seg_end = min(top + client_h, scroll_h)
    if seg_end <= seg_start:
        continue
    # 在截图中，内容行 seg_start 位于 y = cy（容器顶），内容行 seg_end 位于 y = cy + (seg_end - seg_start)
    y0 = cy
    height = seg_end - seg_start
    box = (int(x0 * S), int(y0 * S), int((x0 + w) * S), int((y0 + height) * S))
    crop = im.crop(box)
    parts.append((seg_start, crop))
    print(f'  段{i}: 内容 {seg_start}..{seg_end} -> {crop.size}')

# 拼接时按 seg_start 去重（相邻段有 40px 重叠）。
# 注意：去重必须**只做一次**并把结果存进列表，否则高度和粘贴会重复扣减、
# 接缝错位（这里第一版就写错过）。
trimmed = []
for k, (start, img) in enumerate(parts):
    if k > 0:
        prev_start = parts[k - 1][0]
        overlap = (prev_start + client_h) - start
        if overlap > 0:
            img = img.crop((0, int(overlap * S), img.width, img.height))
    trimmed.append(img)
    print(f'  段{k} 去重后高度 {img.height}（重叠 {0 if k == 0 else max(0, (parts[k-1][0] + client_h) - start)}）')

out_h = sum(img.height for img in trimmed)
canvas = Image.new('RGB', (trimmed[0].width, out_h), (13, 13, 17))
yy = 0
for img in trimmed:
    canvas.paste(img, (0, yy))
    yy += img.height
print('拼接 @2x:', canvas.size)

# 降 1x + 圆角 + hairline
out = canvas.resize((canvas.width // S, canvas.height // S), Image.LANCZOS)
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
g = final.convert('L')
px = g.load()
W, H = g.size
INK = 110
corner = radius + 2
bad = {}
for edge, coords in {
    'left': [(x, y) for y in range(corner, H - corner) for x in range(6)],
    'right': [(W - 1 - x, y) for y in range(corner, H - corner) for x in range(6)],
    'top': [(x, y) for x in range(corner, W - corner) for y in range(6)],
    'bottom': [(x, H - 1 - y) for x in range(corner, W - corner) for y in range(6)],
}.items():
    n = sum(1 for (x, y) in coords if px[x, y] >= INK)
    bad[edge] = n
print('边缘高亮像素(应为 0):', bad)
if any(bad.values()):
    print('!! 仍有边缘切断')
    sys.exit(1)
print('边缘自检通过')
