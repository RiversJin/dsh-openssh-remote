# 拼接设置面板两段截图，并按"苹果式扁平"处理：
#   · 裁到内容并集边界（自带内边距），不带页面背景；
#   · 圆角 + 极轻的一层边界（不投阴影）——扁平化不用投影，靠描边和色块分层；
#   · 输出 1x（README/站点用）。
#
# 拼接依据来自 shot-panel-dark.mjs 存下的 geo.json（内容边界 + 各段 scrollY），
# 重叠量按相邻 scrollY 之差扣除，接缝不会错位。
import json
import sys
from PIL import Image, ImageDraw

prefix = sys.argv[1]
dst = sys.argv[2]
geo = json.load(open(f'{prefix}-geo.json', encoding='utf-8'))

x, top, w, h = geo['x'], geo['top'], geo['w'], geo['h']
segs = geo['segs']
S = 2   # deviceScaleFactor

parts = []
for i, sy in enumerate(segs):
    im = Image.open(f'{prefix}-seg{i}.png')
    # 该段里，面板内容相对视口的 y 偏移 = top - sy
    off = top - sy
    # 段内可见的内容区间（页面坐标）
    seg_top = max(top, sy)
    seg_bottom = min(top + h, sy + geo['vh'])
    if seg_bottom <= seg_top:
        continue
    y0 = seg_top - sy          # 段内像素起点（视口坐标）
    height = seg_bottom - seg_top
    box = (int(x * S), int(y0 * S), int((x + w) * S), int((y0 + height) * S))
    parts.append(im.crop(box))
    print(f'  seg{i}: 取视口 y {y0}..{y0 + height} -> {parts[-1].size}')

total_h = sum(p.height for p in parts)
out = Image.new('RGB', (parts[0].width, total_h), (13, 13, 17))
yy = 0
for p in parts:
    out.paste(p, (0, yy))
    yy += p.height
print('拼接 @2x:', out.size)

# 降到 1x
out = out.resize((out.width // S, out.height // S), Image.LANCZOS)

# 圆角 + 细描边（扁平风格：无投影）
radius = 12
mask = Image.new('L', out.size, 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, out.size[0] - 1, out.size[1] - 1], radius=radius, fill=255)
canvas = Image.new('RGB', out.size, (13, 13, 17))
canvas.paste(out, (0, 0), mask)

draw = ImageDraw.Draw(canvas)
draw.rounded_rectangle([0, 0, out.size[0] - 1, out.size[1] - 1], radius=radius,
                       outline=(58, 58, 72), width=1)
canvas.save(dst, optimize=True)
print(f'最终 {dst} {canvas.size}')

# 边缘对称性检查：左右边缘的平均亮度应接近
g = canvas.convert('L')
px = g.load()
W, H = g.size


def edge(xs):
    vals = []
    for xx in xs:
        s = 0
        n = 0
        for y in range(int(H * 0.08), int(H * 0.92)):
            s += px[xx, y]
            n += 1
        vals.append(s / max(n, 1))
    return vals


left = edge([1, 2, 3])
right = edge([W - 2, W - 3, W - 4])
print(f'左缘均值 {sum(left)/len(left):.1f}  右缘均值 {sum(right)/len(right):.1f}  差 {abs(sum(left)/len(left)-sum(right)/len(right)):.1f}')
