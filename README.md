# 六弦调音器 SIX/STRING

浏览器里的吉他调音器，v1 只支持标准调音 E2 A2 D3 G3 B3 E4。纯静态页面，没有依赖和构建步骤，可以直接用 GitHub Pages 发布。

## 功能

- 自动识别正在弹的弦；点下方琴弦可以锁定只调这一根，再点一次恢复自动。
- LED 指示条显示 ±50 音分偏差，同时给出 Hz 和音分数值。偏差进入 ±3 音分算调准，超出 ±6 音分才退出，避免来回跳。
- 琴头示意图高亮要拧的旋钮，并提示拧紧还是拧松。
- 锁定琴弦时，如果音高接近目标的 2 倍，提醒"高了一个八度，小心断弦"。
- 音频只在本机分析，不上传。

## 准确度设计

- 音高检测用 McLeod NSDF（归一化平方差函数）加抛物线插值，见 `js/pitch.js`。普通自相关会让低音弦读数偏高几个音分，NSDF 的归一化修正了这个问题。
- 麦克风关闭回声消除、降噪和自动增益，因为它们会把持续的单音当成噪声处理。
- 每次分析 4096 个采样点（48kHz 下约 85ms），每秒约 25 次。跳过拨弦后最开始 120ms 的偏高段，再对最近 5 次读数取中位数，并丢掉孤立的离群值。
- 测试用模拟拨弦信号覆盖 6 根弦、±30 音分偏差、44.1k 和 48k 两种采样率，以及弱信号、噪声、弦的非谐性，要求误差都不超过 ±2 音分。

## 目录

```
index.html        页面结构
style.css         样式（不引用外部字体或 CDN）
js/pitch.js       音高检测，不依赖 DOM
js/tuner.js       琴弦识别、平滑、调准判定
js/segments.js    七段数码管显示（SVG）
js/app.js         麦克风、音频循环、界面渲染
test/             Node 测试
```

## 本地预览

浏览器只在 HTTPS 或 `localhost` 下允许使用麦克风，直接双击打开 `index.html` 不行。

```bash
npm start           # 即 python3 -m http.server 8000
# 打开 http://localhost:8000
```

用手机测试时需要 HTTPS，建议先发布到 GitHub Pages 再用手机打开。

## 测试

需要 Node 18 或更高版本，没有其他依赖。

```bash
npm test
```

## 发布到 GitHub Pages

1. 在 GitHub 新建一个 repo，例如 `guitartune`。
2. 推送代码：
   ```bash
   git init
   git add .
   git commit -m "Guitar tuner v1"
   git branch -M main
   git remote add origin git@github.com:<你的用户名>/guitartune.git
   git push -u origin main
   ```
3. 进入 repo 的 Settings → Pages，Source 选 "Deploy from a branch"，Branch 选 `main`、目录选 `/ (root)`，保存。
4. 一两分钟后即可通过 `https://<你的用户名>.github.io/guitartune/` 访问。

所有资源路径都是相对路径，放在子路径下也能正常加载。免费账号要求 repo 公开才能使用 Pages。国内访问 `github.io` 可能较慢。

## 已知限制

- 只做了模拟信号测试和 Chrome 自动化测试，还需要用真琴实测，最好和硬件调音器对比读数。
- iOS Safari 的兼容性还没在真机上验证。
- 在嘈杂环境里准确度会下降，这类场景更适合夹式调音器。
