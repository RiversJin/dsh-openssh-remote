# 静态验证图片在页面里的几何（不依赖浏览器加载，避开 headless 下 lazy 不触发的问题）。
#
# 验证的是"CSS 约束 + 图片自然尺寸"是否匹配：
#   · .shots figure img  有固定 height + object-fit:cover  => 并排两张不会互相压扁
#   · figure.wide img    宽度 100% => 按比例显示，不会坍缩
# 这正是之前真实出问题的地方（三列网格把 612/1280 宽的图压到 332，长图把同行压成 1px）。
import re
from PIL import Image

html = open('docs/index.html', encoding='utf-8').read()

imgs = re.findall(r'src="\./(shots/[^"]+)"', html)
print('页面引用的配图:')
for rel in imgs:
    im = Image.open('docs/' + rel)
    print(f'  {rel:34} natural={im.size[0]}x{im.size[1]}')

# 抽取关键 CSS
def rule(sel):
    m = re.search(re.escape(sel) + r'\s*\{([^}]*)\}', html)
    return m.group(1).strip() if m else None

shots_img = rule('.shots figure img')
wide_rule = rule('figure.wide')
print('\nCSS 约束:')
print('  .shots figure img ->', (shots_img or '(未定义)').replace('\n', ' ')[:110])

problems = []

# 1) 并排的两张必须有固定高度 + object-fit，否则长图会撑高整行、把另一张压扁
if not shots_img:
    problems.append('.shots figure img 未定义：并排图会互相压扁')
else:
    if 'height' not in shots_img:
        problems.append('.shots figure img 没有固定高度：长图会撑高整行')
    if 'object-fit' not in shots_img:
        problems.append('.shots figure img 没有 object-fit：长图会被拉伸变形')

# 2) 并排的图不能同时带 width:100% 且无 object-fit（会按各自比例撑高）
if shots_img and 'width' in shots_img and 'object-fit' not in shots_img:
    problems.append('并排图同时有 width 与无 object-fit')

# 3) 全宽图（能力总览）必须按比例：不能设固定 height
if wide_rule and 'height' in wide_rule:
    problems.append('能力总览设了固定高度，会裁掉内容')

print('\n问题:', '; '.join(problems) if problems else '无')
raise SystemExit(1 if problems else 0)
