# 把 app/shots-demo/ 的帧序列（gh-demo-gif.mjs 的产物）合成 assets/demo.gif。
#
# 依赖：Pillow（仅生成时需要，仓库产物是合成好的 demo.gif）
#   pip install Pillow
# 用法（在仓库根目录）：
#   python app/scripts/make-demo-gif.py
#
# 可调参数见下 PARALLEL 常量组；无参数时按 manifest.json 全量合成。

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "app" / "shots-demo"
OUT = ROOT / "assets" / "demo.gif"

TARGET_WIDTH = 1000          # 最终 GIF 宽度（原帧是 2x 采集）
COLORS = 256                 # 全局调色板色数；UI 是白底 + 少量语义色，256 绰绰有余
DITHER = Image.Dither.NONE   # 文字边缘不做抖动，抖动会让 14px 中文发花
MIN_DURATION_MS = 110        # 浏览器会按 20ms 取整，太短的帧反而拖时间

manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
frames_spec = manifest["frames"]

first = Image.open(SRC / frames_spec[0]["file"]).convert("RGB")
scale = TARGET_WIDTH / first.width
target_size = (TARGET_WIDTH, round(first.height * scale))

# 全局调色板：从时间最长的关键帧采样（信息量最大），应用到全部帧保证颜色一致
keyframe = max(frames_spec, key=lambda f: f["duration"])
master_rgb = Image.open(SRC / keyframe["file"]).convert("RGB").resize(target_size, Image.LANCZOS)
master = master_rgb.quantize(colors=COLORS, method=Image.MEDIANCUT, dither=DITHER)

palette_frames: list[Image.Image] = []
durations: list[int] = []
for spec in frames_spec:
    im = Image.open(SRC / spec["file"]).convert("RGB").resize(target_size, Image.LANCZOS)
    palette_frames.append(im.quantize(palette=master, dither=DITHER))
    durations.append(max(MIN_DURATION_MS, spec["duration"]))

OUT.parent.mkdir(parents=True, exist_ok=True)
palette_frames[0].save(
    OUT,
    save_all=True,
    append_images=palette_frames[1:],
    duration=durations,
    loop=0,
    optimize=True,
)

size_kb = OUT.stat().st_size / 1024
total_s = sum(durations) / 1000
print(f"demo.gif: {OUT}")
print(f"{len(frames_spec)} 帧 · {target_size[0]}x{target_size[1]} · {total_s:.1f}s · {size_kb:.0f} KB")
if size_kb > 3500:
    print("⚠ 超过 3.5MB，建议把 TARGET_WIDTH 降到 880 或删掉非关键帧", file=sys.stderr)
