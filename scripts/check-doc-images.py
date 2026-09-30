# 检查 README / Pages 引用的本地图片是否都存在且非空。
#
# 为什么不走浏览器：前一个版本在 CDP 里跑本地 HTTP 服务 + 双页导航，句柄没释放
# 导致整个脚本挂死（超时 300s）。图片存在性这种静态事实，直接查文件系统更快更稳。
#
# 判据：
#   1) 每个被引用的相对路径必须存在；
#   2) 必须是可解析的 PNG 且尺寸合理（> 200x150），避免误放占位图；
#   3) 覆盖率：README 里至少有一张图（防"全删了"这种极端回归）。
import re
import sys
from pathlib import Path
from PIL import Image

root = Path('.')
SRC_FILES = ['README.md', 'README.en.md', 'docs/index.html', 'docs/stats/index.html', 'screenshots.json']

# 引用形式: ![alt](path) / <img src="path"> / JSON 数组里的字符串
PATTERNS = [
    re.compile(r'!\[[^\]]*\]\(([^)\s]+)\)'),
    re.compile(r'<img[^>]+src="([^"]+)"'),
    re.compile(r'"((?:docs|\./)[^"]+\.(?:png|svg|jpg|jpeg))"'),
]

problems = []
checked = []

for f in SRC_FILES:
    p = root / f
    if not p.exists():
        problems.append(f'{f}: 文件不存在')
        continue
    text = p.read_text(encoding='utf-8')
    base = p.parent
    for pat in PATTERNS:
        for m in pat.finditer(text):
            ref = m.group(1)
            if ref.startswith(('http://', 'https://', 'data:')):
                continue
            # 相对引用：README 在根目录 -> repo 根；docs/*.html -> docs/
            target = (root / ref) if not ref.startswith('./') else (base / ref[2:])
            if not target.exists():
                target = base / ref
            if not target.exists():
                problems.append(f'{f}: 引用不存在 -> {ref}')
                continue
            if target.suffix.lower() == '.png':
                try:
                    im = Image.open(target)
                    w, h = im.size
                    if w < 200 or h < 150:
                        problems.append(f'{f}: 图片过小疑似占位 -> {ref} ({w}x{h})')
                    checked.append((f, ref, f'{w}x{h}', target.stat().st_size))
                except Exception as e:
                    problems.append(f'{f}: 无法解析 PNG -> {ref}: {e}')
            else:
                checked.append((f, ref, 'svg/other', target.stat().st_size))

print(f'检查了 {len(checked)} 个图片引用:')
for f, ref, dim, size in checked:
    print(f'  ok   {f} -> {ref}  [{dim}, {size // 1024}KB]')

if problems:
    print('\n问题:')
    for x in problems:
        print('  !!', x)
    sys.exit(1)

# 覆盖率：README 必须至少引用一张图
for f in ['README.md', 'README.en.md']:
    n = len(re.findall(r'!\[[^\]]*\]\([^)]+\)|<img[^>]+src=', (root / f).read_text(encoding='utf-8')))
    print(f'{f}: {n} 张图')
    if n < 3:
        print(f'  !! {f} 图片过少（预期 >= 3）')
        sys.exit(1)

print('\n图片引用检查: 全部通过')
