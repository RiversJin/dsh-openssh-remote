# 把过长的设置面板裁到"有信息量的上半段"，用于配图。
#
# 为什么裁：面板原始 535x997，若按比例全宽显示会占据近千像素高度、把页面撑得很长；
# 而配图只需要传达"这里能管机器、能测连接、有转发与审计"。
# 裁到 535x640 覆盖：机器列表 → 高级配置 → 测试连接/保存 → 最近工作区 → 端口转发。
#
# 同时**避免放大**：两张并排图都按各自更小的比例显示（源图 >= 显示宽度），
# 之前用固定 height:360 + object-fit:cover 会把 595x224 的扁图放大 1.6 倍而模糊。
from PIL import Image
import sys

src, dst, keep = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src)
if im.height <= keep:
    print(f'{src} 高度 {im.height} <= {keep}，无需裁')
    im.save(dst, optimize=True) if src != dst else None
else:
    out = im.crop((0, 0, im.width, keep))
    out.save(dst, optimize=True)
    print(f'{src} {im.size} -> {dst} {out.size}（保留顶部 {keep}px）')
