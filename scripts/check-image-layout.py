# 静态验证配图在页面里的几何（不依赖浏览器加载，避开 headless 下 lazy 不触发）。
#
# 判据随方案演进过两次，这里只保留**当前方案**的要求：
#   方案：并排图竖向排列，各自 width:100% + height:auto + 逐图 max-width 上限，
#         绝不放大位图（放大位图 = 模糊）。
#   （旧的"固定 height + object-fit:cover"方案已被否决：它会把 595x224 的扁图
#     放大 1.6 倍而模糊，而那正是当初踩过的坑。）
import re
import sys
from PIL import Image

html = open('docs/index.html', encoding='utf-8').read()


def rule(sel):
    m = re.search(re.escape(sel) + r'\s*\{([^}]*)\}', html)
    return m.group(1).strip() if m else None


shots_css = rule('.shots figure img') or rule('.shots figure img')
wide_css = rule('figure.wide')
shots_grid = rule('.shots')

print('页面引用的配图:')
for rel in re.findall(r'src="\./(shots/[^"]+)"', html):
    im = Image.open('docs/' + rel)
    print(f'  {rel:32} natural={im.size[0]}x{im.size[1]}')

print('\nCSS 约束:')
print('  .shots            ->', (shots_grid or '(无)').replace('\n', ' ')[:90])
print('  .shots figure img ->', (shots_css or '(未定义)').replace('\n', ' ')[:110])

problems = []

if not shots_css:
    problems.append('.shots figure img 未定义')
else:
    # 方案要求：按比例 + 不放大。若回到"固定高度 + cover"就是倒退。
    if 'height' in shots_css and 'auto' not in shots_css:
        problems.append('.shots figure img 设了非 auto 高度：会拉伸/压扁位图')
    if 'object-fit' in shots_css and 'cover' in shots_css:
        problems.append('.shots figure img 用了 object-fit:cover：扁图会被放大而模糊')

# 逐图必须有 max-width 上限（防止位图被拉到容器宽度而放大）
inline = re.findall(r'class="shots"[\s\S]*?</div>', html)
caps = re.findall(r'style="max-width:(\d+)px"', inline[0] if inline else '')
n_imgs = len(re.findall(r'src="\./shots/', inline[0] if inline else ''))
print(f'\n并排区: {n_imgs} 张图, {len(caps)} 个 max-width 上限: {caps}')
if len(caps) < n_imgs:
    problems.append(f'并排区有 {n_imgs} 张图但只有 {len(caps)} 个 max-width 上限')

# 上限不得超过图片真实宽度（否则就是放大）
for cap, rel in zip(caps, re.findall(r'src="\./(shots/[^"]+)"', inline[0] if inline else '')):
    im = Image.open('docs/' + rel)
    if int(cap) > im.size[0]:
        problems.append(f'{rel}: max-width {cap} > 实际宽度 {im.size[0]}（会放大）')

print('\n问题:', '; '.join(problems) if problems else '无')
sys.exit(1 if problems else 0)
