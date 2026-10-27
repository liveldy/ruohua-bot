# 感知侧车（python/sidecar.py）

**只用 Python 标准库**（3.9+），不用装任何东西就能起：文本向量、记忆强度打分、Windows 截屏，以及可选的语音识别与 OCR；Node 端探不到它会按 `config.sidecar.autostart` 后台拉起这个脚本。

## 怎么起

```bash
python python/sidecar.py --host 127.0.0.1 --port 8765 [--data-dir data]
python python/sidecar.py --port 8765 --selftest     # 跑一遍自检后退出，失败时退出码 1
```

控制台中文乱码就加 `PYTHONIOENCODING=utf-8`；程序之间的 JSON 响应一直是 UTF-8，不受影响。配置在 `config.sidecar`
（`enabled` / `url` / `autostart` / `python` / `script` / `host` / `port` / `timeoutMs` / `screenshotDir`），`.env` 的 `SIDECAR_*` 可覆盖。

## 接口

全部返回 JSON；handler 内部异常也返回 `{"ok": false, "error": "..."}`。

| 方法 路径 | 关键字段 |
| --- | --- |
| `GET /` | 纯文本说明页 |
| `GET /health` | `features: { embed, screenshot, asr, ocr }`、`dataDir`、`ocrBackends` |
| `POST /embed` | 入 `{ texts }` → `{ vectors, dim }`，512 维字符 n-gram 哈希向量 |
| `POST /similar` | 入 `{ a, b }` → `{ score }`，余弦相似度（同一输入永远同一个向量） |
| `POST /score` / `POST /consolidate` | 记忆强度 `{ items, now?, halfLifeHours? }` → `{ scores }`；巩固建议 `{ items, thresholds }` → `{ keep, promote, drop, merge }` |
| `GET /screenshot` | `?path=<p>&monitor=0` → `{ ok, path, width, height }`；Windows 截屏存 BMP |
| `POST /asr` | 入 `{ path, model?, language? }` → `{ ok, text }`，语音转文字 |
| `POST /ocr` | 入 `{ path, language? }` → `{ ok, text }`，图片文字识别 |

记忆强度：`score = min(1, importance × recency × access)`，`recency = 0.5 ** (距今小时数 / halfLifeHours)`（默认半衰期
72 小时，`kind: 'permanent'` 恒为 1），`access = 1 + 0.15 × ln(1 + accessCount)`；`lastAccessAt` 有值就从它算起。

## 可选依赖

`python -m pip install -r python/requirements.txt`，三条都可选：

| 依赖 | 解锁 | 没装时 |
| --- | --- | --- |
| `faster-whisper` | `POST /asr` | `{"ok": false, "error": "asr_unsupported"}` |
| `pytesseract` + `Pillow` | `POST /ocr` 的一个后端 | 自动改用 Windows.Media.Ocr |
| — | Windows 自带 `Windows.Media.Ocr` | `{"ok": false, "error": "ocr_unsupported"}` |

声学模型懒加载（第一次调 `/asr` 才建）；`RUOHUA_ASR_MODEL`（默认 `base`）、`RUOHUA_ASR_DEVICE` /
`RUOHUA_ASR_COMPUTE`（默认 cpu / int8）可调。

## 本地化键

`python/i18n.py` 读同一批本地化键（只用标准库）：默认文字 `src/i18n/locales/zh-CN/sidecar.json`，管理员
在面板改过的覆盖在 `<仓库根>/data/locales/zh-CN.json`（覆盖优先），找不到键就返回键本身。`sidecar.py`
里不留写死的中文，`node tools/dev/check-i18n.mjs` 会连 Python 一起体检。
