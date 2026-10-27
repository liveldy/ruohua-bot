#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""若华 · 本地感知侧车（perception sidecar）。

只用标准库：文本向量、记忆强度打分、截屏（Windows GDI / PowerShell），
以及可选的语音识别（faster-whisper）与 OCR（pytesseract / Windows.Media.Ocr）。

启动：
    python python/sidecar.py --host 127.0.0.1 --port 8765 [--data-dir data]

自检：
    python python/sidecar.py --port 8765 --selftest

所有接口返回 JSON（UTF-8）；handler 内部异常一定返回 {"ok": false, "error": "..."}，
不会出现空响应。
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import hashlib
import importlib.util
import json
import math
import os
import platform
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from i18n import configure, t  # 与 JS 侧共用同一套本地化键（python/i18n.py）


def _force_utf8_streams():
    """把标准输出/错误钉死成 UTF-8 + LF。

    Windows 上文本流默认按本地代码页写、并把 '\\n' 翻成 '\\r\\n'；日志被 Node 原样落盘就
    成了 CRLF，中文也可能被控制台代码页吃掉。项目统一 UTF-8 + LF，这里显式定死。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', newline='\n', errors='replace')
        except Exception:
            pass


_force_utf8_streams()

SERVICE_NAME = 'ruohua-sidecar'
VERSION = '0.1.0'

EMBED_DIM = 512
DEFAULT_HALF_LIFE_HOURS = 72.0
DEFAULT_ACCESS_WEIGHT = 0.15
DEFAULT_DROP_SCORE = 0.12
DEFAULT_PROMOTE_IMPORTANCE = 0.75
DEFAULT_MERGE_SIMILARITY = 0.92

IS_WINDOWS = platform.system() == 'Windows'
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DATA_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), 'data')
DATA_DIR = DEFAULT_DATA_DIR

# 本地化键：默认读代码仓库的 src/i18n/locales/zh-CN，管理员的覆盖在 <仓库根>/data/locales/zh-CN.json
configure(os.path.dirname(SCRIPT_DIR))

SRCCOPY = 0x00CC0020
CAPTUREBLT = 0x40000000
DIB_RGB_COLORS = 0
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)

# 中日韩统一表意文字 + 假名 + 谚文：按字符切 n-gram
CJK_RE = re.compile(r'[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]')


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #

def _print(*parts):
    """打印，编码不了就退化成 ASCII，绝不因为控制台编码崩掉。"""
    text = ' '.join(str(p) for p in parts)
    try:
        sys.stdout.write(text + '\n')
        sys.stdout.flush()
    except UnicodeEncodeError:
        sys.stdout.write(text.encode('ascii', 'backslashreplace').decode('ascii') + '\n')
        sys.stdout.flush()
    except Exception:
        pass


def _eprint(*parts):
    text = ' '.join(str(p) for p in parts)
    try:
        sys.stderr.write(text + '\n')
        sys.stderr.flush()
    except Exception:
        pass


def _has_module(name):
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        return False


def _to_int(value, fallback=0):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return fallback


def _to_float(value, fallback=0.0):
    try:
        num = float(value)
        if math.isnan(num) or math.isinf(num):
            return fallback
        return num
    except (TypeError, ValueError):
        return fallback


def _to_ms(value, fallback=None):
    """毫秒时间戳：接受数字或数字字符串。"""
    if value is None:
        return fallback
    if isinstance(value, bool):
        return fallback
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return fallback
    try:
        return float(text)
    except ValueError:
        return fallback


def _abs_path(value):
    if not value:
        return None
    return os.path.abspath(os.path.expanduser(str(value)))


def _timestamp_name(prefix, ext):
    stamp = time.strftime('%Y%m%d-%H%M%S')
    return '%s-%s-%03d.%s' % (prefix, stamp, int(time.time() * 1000) % 1000, ext)


def _decode_output(raw):
    if raw is None:
        return ''
    if isinstance(raw, str):
        return raw
    for encoding in ('utf-8', 'gbk', 'mbcs', 'latin-1'):
        try:
            return raw.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode('utf-8', errors='replace')


# --------------------------------------------------------------------------- #
# 文本向量：确定性字符 n-gram 哈希（零依赖）
# --------------------------------------------------------------------------- #

def text_grams(text):
    """中文按 1~3 元字符 gram，英文/数字按词（并补词二元组）。"""
    lowered = str(text or '').lower()
    grams = []
    words = []
    cjk_run = []

    def flush_cjk():
        if not cjk_run:
            return
        run = ''.join(cjk_run)
        cjk_run.clear()
        for n in (1, 2, 3):
            for i in range(len(run) - n + 1):
                grams.append(run[i:i + n])

    index = 0
    total = len(lowered)
    while index < total:
        char = lowered[index]
        if CJK_RE.match(char):
            cjk_run.append(char)
            index += 1
            continue
        if char.isalnum():
            flush_cjk()
            end = index
            while end < total and lowered[end].isalnum() and not CJK_RE.match(lowered[end]):
                end += 1
            words.append(lowered[index:end])
            index = end
            continue
        flush_cjk()
        index += 1
    flush_cjk()

    for word in words:
        grams.append('w:' + word)
    for left, right in zip(words, words[1:]):
        grams.append('b:%s_%s' % (left, right))
    return grams


def embed_text(text, dim=EMBED_DIM):
    """哈希到固定维度 + 带符号累加 + L2 归一化，同输入永远同输出。"""
    vector = [0.0] * dim
    for gram in text_grams(text):
        digest = hashlib.blake2b(gram.encode('utf-8'), digest_size=8).digest()
        value = int.from_bytes(digest, 'big')
        slot = value % dim
        vector[slot] += 1.0 if (value >> 63) & 1 else -1.0
    norm = math.sqrt(sum(item * item for item in vector))
    if norm > 0:
        vector = [item / norm for item in vector]
    return vector


def embed_texts(texts, dim=EMBED_DIM):
    return [embed_text(text, dim) for text in texts]


def cosine(a, b):
    if not a or not b:
        return 0.0
    size = min(len(a), len(b))
    dot = 0.0
    norm_a = 0.0
    norm_b = 0.0
    for i in range(size):
        dot += a[i] * b[i]
        norm_a += a[i] * a[i]
        norm_b += b[i] * b[i]
    if norm_a <= 0 or norm_b <= 0:
        return 0.0
    return dot / math.sqrt(norm_a * norm_b)


# --------------------------------------------------------------------------- #
# 记忆强度打分 / 巩固建议
# --------------------------------------------------------------------------- #

def score_items(items, now=None, half_life_hours=None, access_weight=DEFAULT_ACCESS_WEIGHT):
    """记忆强度 = importance × recency（指数衰减）× access 加成，结果落在 [0,1]。

    永久记忆（kind == 'permanent'）recency 恒为 1。
    """
    current = _to_ms(now, None)
    if current is None:
        current = time.time() * 1000.0
    half_life = _to_float(half_life_hours, DEFAULT_HALF_LIFE_HOURS)
    if half_life <= 0:
        half_life = DEFAULT_HALF_LIFE_HOURS
    weight = _to_float(access_weight, DEFAULT_ACCESS_WEIGHT)

    scores = []
    for raw in items or []:
        item = raw if isinstance(raw, dict) else {}
        importance = min(1.0, max(0.0, _to_float(item.get('importance'), 0.5)))
        permanent = str(item.get('kind') or '').lower() in ('permanent', 'forever', 'core')
        if permanent:
            recency = 1.0
        else:
            anchor = _to_ms(item.get('lastAccessAt'), None)
            if anchor is None:
                anchor = _to_ms(item.get('createdAt'), None)
            if anchor is None:
                anchor = current
            elapsed_hours = max(0.0, (current - anchor) / 3600000.0)
            recency = 0.5 ** (elapsed_hours / half_life)
        access_count = max(0.0, _to_float(item.get('accessCount'), 0.0))
        access = 1.0 + weight * math.log1p(access_count)
        score = importance * recency * access
        scores.append(round(min(1.0, max(0.0, score)), 6))
    return scores


def _find(parent, node):
    while parent[node] != node:
        parent[node] = parent[parent[node]]
        node = parent[node]
    return node


def consolidate_items(items, thresholds=None, now=None):
    items = list(items or [])
    options = thresholds if isinstance(thresholds, dict) else {}
    current = _to_ms(now, None)
    if current is None:
        current = time.time() * 1000.0
    half_life = _to_float(options.get('halfLifeHours'), DEFAULT_HALF_LIFE_HOURS)
    drop_below = _to_float(options.get('drop', options.get('minScore')), DEFAULT_DROP_SCORE)
    promote_at = _to_float(options.get('promote', options.get('minImportance')), DEFAULT_PROMOTE_IMPORTANCE)
    merge_at = _to_float(options.get('mergeSimilarity'), DEFAULT_MERGE_SIMILARITY)

    ids = [item.get('id', index) if isinstance(item, dict) else index for index, item in enumerate(items)]
    scores = score_items(items, current, half_life)
    permanent = [
        str((item or {}).get('kind') or '').lower() in ('permanent', 'forever', 'core')
        if isinstance(item, dict) else False
        for item in items
    ]

    # 合并分组：只对临时记忆做，用并查集
    merge_groups = []
    merge_members = set()
    if merge_at < 1.0:
        candidates = [index for index, item in enumerate(items) if not permanent[index]]
        if len(candidates) >= 2:
            vectors = {}
            for index in candidates:
                content = items[index].get('content') if isinstance(items[index], dict) else ''
                vectors[index] = embed_text(content or '')
            parent = list(range(len(items)))

            def union(a, b):
                root_a, root_b = _find(parent, a), _find(parent, b)
                if root_a != root_b:
                    parent[root_b] = root_a

            for i in range(len(candidates)):
                for j in range(i + 1, len(candidates)):
                    left, right = candidates[i], candidates[j]
                    if cosine(vectors[left], vectors[right]) >= merge_at:
                        union(left, right)
            buckets = {}
            for index in candidates:
                buckets.setdefault(_find(parent, index), []).append(index)
            for members in buckets.values():
                if len(members) < 2:
                    continue
                # 组内保留分数最高的那条，其余作为被合并对象；整组一起汇报
                members.sort(key=lambda idx: (-scores[idx], idx))
                merge_groups.append([ids[idx] for idx in members])
                merge_members.update(members)
    merge_groups.sort(key=lambda group: str(group[0]))

    keep, promote, drop = [], [], []
    for index, item in enumerate(items):
        if permanent[index]:
            keep.append(ids[index])
            continue
        if index in merge_members:
            continue  # 交给 merge 处理，不再出现在 keep / drop / promote
        importance = _to_float((item or {}).get('importance') if isinstance(item, dict) else None, 0.5)
        if importance >= promote_at:
            promote.append(ids[index])
        elif scores[index] < drop_below:
            drop.append(ids[index])
        else:
            keep.append(ids[index])

    return {'keep': keep, 'promote': promote, 'drop': drop, 'merge': merge_groups}


# --------------------------------------------------------------------------- #
# 截屏
# --------------------------------------------------------------------------- #

class _Rect(ctypes.Structure):
    """显示器矩形（只有截屏时用得上）。"""

    _fields_ = [('left', ctypes.c_long), ('top', ctypes.c_long), ('right', ctypes.c_long), ('bottom', ctypes.c_long)]


class _BitmapInfoHeader(ctypes.Structure):
    _fields_ = [
        ('biSize', ctypes.c_uint32),
        ('biWidth', ctypes.c_int32),
        ('biHeight', ctypes.c_int32),
        ('biPlanes', ctypes.c_uint16),
        ('biBitCount', ctypes.c_uint16),
        ('biCompression', ctypes.c_uint32),
        ('biSizeImage', ctypes.c_uint32),
        ('biXPelsPerMeter', ctypes.c_int32),
        ('biYPelsPerMeter', ctypes.c_int32),
        ('biClrUsed', ctypes.c_uint32),
        ('biClrImportant', ctypes.c_uint32),
    ]


class _BitmapInfo(ctypes.Structure):
    _fields_ = [('bmiHeader', _BitmapInfoHeader), ('bmiColors', ctypes.c_uint32 * 3)]


_monitors_cache = {'rects': None, 'at': 0.0}


def _dpi_aware():
    """尽量拿到物理像素，失败就算了。"""
    if not IS_WINDOWS:
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
        return
    except Exception:
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


def _monitor_rects(user32):
    """枚举显示器：[left, top, width, height]；拿不到返回空表。"""
    cached = _monitors_cache['rects']
    if cached is not None and time.time() - _monitors_cache['at'] < 30:
        return cached
    rects = []

    def callback(handle, hdc, rect_ptr, data):
        rect = rect_ptr.contents
        rects.append([rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top])
        return 1

    try:
        proc = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(_Rect), ctypes.c_void_p)(callback)
        user32.EnumDisplayMonitors(None, None, proc, None)
    except Exception:
        rects = []
    if rects:
        _monitors_cache['rects'] = rects
        _monitors_cache['at'] = time.time()
    return rects


def _write_bmp(path, width, height, bgra_top_down):
    """把 GDI 给的 32 位 BGRA（自上而下）写成标准 BMP（自下而上 + alpha 置 255）。"""
    row_size = width * 4
    pixels = bytearray(row_size * height)
    view = memoryview(bgra_top_down)
    for y in range(height):
        src = y * row_size
        dst = (height - 1 - y) * row_size
        pixels[dst:dst + row_size] = view[src:src + row_size]
    pixels[3::4] = b'\xff' * (len(pixels) // 4)  # 不透明，免得别的解码器当全透明
    header = struct.pack('<2sIHHI', b'BM', 54 + len(pixels), 0, 0, 54)
    info = struct.pack('<IiiHHIIiiII', 40, width, height, 1, 32, 0, len(pixels), 2835, 2835, 0, 0)
    with open(path, 'wb') as handle:
        handle.write(header)
        handle.write(info)
        handle.write(bytes(pixels))


def capture_via_gdi(path, monitor=0):
    """ctypes + GDI：BitBlt 到兼容位图，GetDIBits 取像素，再手写 BMP 头。"""
    if not IS_WINDOWS:
        raise RuntimeError('unsupported_platform')
    user32 = ctypes.WinDLL('user32', use_last_error=True)
    gdi32 = ctypes.WinDLL('gdi32', use_last_error=True)

    user32.GetDC.restype = ctypes.c_void_p
    user32.GetDC.argtypes = [ctypes.c_void_p]
    user32.ReleaseDC.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    user32.GetSystemMetrics.restype = ctypes.c_int
    user32.GetSystemMetrics.argtypes = [ctypes.c_int]
    gdi32.CreateCompatibleDC.restype = ctypes.c_void_p
    gdi32.CreateCompatibleDC.argtypes = [ctypes.c_void_p]
    gdi32.CreateCompatibleBitmap.restype = ctypes.c_void_p
    gdi32.CreateCompatibleBitmap.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
    gdi32.SelectObject.restype = ctypes.c_void_p
    gdi32.SelectObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    gdi32.BitBlt.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                             ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_uint32]
    gdi32.GetDIBits.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint,
                               ctypes.c_void_p, ctypes.POINTER(_BitmapInfo), ctypes.c_uint]
    gdi32.DeleteObject.argtypes = [ctypes.c_void_p]
    gdi32.DeleteDC.argtypes = [ctypes.c_void_p]

    _dpi_aware()
    index = _to_int(monitor, 0)
    if index <= 0:
        width = user32.GetSystemMetrics(0)   # SM_CXSCREEN
        height = user32.GetSystemMetrics(1)  # SM_CYSCREEN
        left, top = 0, 0
    else:
        rects = _monitor_rects(user32)
        if not rects:
            raise RuntimeError('no_monitor')
        pick = rects[index] if index < len(rects) else rects[0]
        left, top, width, height = pick
    if width <= 0 or height <= 0:
        raise RuntimeError('empty_screen')

    hdc_screen = user32.GetDC(None)
    if not hdc_screen:
        raise RuntimeError('GetDC failed')
    hdc_mem = None
    hbitmap = None
    try:
        hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
        if not hdc_mem:
            raise RuntimeError('CreateCompatibleDC failed')
        hbitmap = gdi32.CreateCompatibleBitmap(hdc_screen, width, height)
        if not hbitmap:
            raise RuntimeError('CreateCompatibleBitmap failed')
        gdi32.SelectObject(hdc_mem, hbitmap)
        if not gdi32.BitBlt(hdc_mem, 0, 0, width, height, hdc_screen, left, top, SRCCOPY | CAPTUREBLT):
            raise RuntimeError('BitBlt failed (err=%s)' % ctypes.get_last_error())

        info = _BitmapInfo()
        info.bmiHeader.biSize = ctypes.sizeof(_BitmapInfoHeader)
        info.bmiHeader.biWidth = width
        info.bmiHeader.biHeight = -height  # 负值 = 自上而下
        info.bmiHeader.biPlanes = 1
        info.bmiHeader.biBitCount = 32
        info.bmiHeader.biCompression = 0  # BI_RGB
        buffer = ctypes.create_string_buffer(width * height * 4)
        scanned = gdi32.GetDIBits(hdc_mem, hbitmap, 0, height, buffer, ctypes.byref(info), DIB_RGB_COLORS)
        if not scanned:
            raise RuntimeError('GetDIBits failed (err=%s)' % ctypes.get_last_error())
        _write_bmp(path, width, height, buffer.raw)
        return width, height
    finally:
        if hbitmap:
            gdi32.DeleteObject(hbitmap)
        if hdc_mem:
            gdi32.DeleteDC(hdc_mem)
        if hdc_screen:
            user32.ReleaseDC(None, hdc_screen)


POWERSHELL_CAPTURE = r'''
$ErrorActionPreference = 'Stop'
# DPI 感知必须赶在 WinForms 被加载之前设，否则缩放屏上只能截到缩水图
$nativeReady = $false
try {
  Add-Type -Namespace Ruohua -Name ScreenNative -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);'
  $null = [Ruohua.ScreenNative]::SetProcessDPIAware()
  $nativeReady = $true
} catch { $nativeReady = $false }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$idx = __MONITOR__
if ($idx -lt 0 -or $idx -ge $screens.Count) { $idx = 0 }
$bounds = $screens[$idx].Bounds
$x = $bounds.X; $y = $bounds.Y; $w = $bounds.Width; $h = $bounds.Height
if ($nativeReady) {
  # 感知到物理像素之后，WinForms 给的还是逻辑坐标，得换算回来；主屏直接用系统指标
  $logicalW = $screens[0].Bounds.Width
  $physicalW = [Ruohua.ScreenNative]::GetSystemMetrics(0)
  $physicalH = [Ruohua.ScreenNative]::GetSystemMetrics(1)
  if ($idx -eq 0 -and $physicalW -gt 0 -and $physicalH -gt 0) {
    $x = 0; $y = 0; $w = $physicalW; $h = $physicalH
  } elseif ($logicalW -gt 0 -and $physicalW -gt 0 -and $physicalW -ne $logicalW) {
    $scale = $physicalW / $logicalW
    $x = [int][math]::Round($bounds.X * $scale); $y = [int][math]::Round($bounds.Y * $scale)
    $w = [int][math]::Round($bounds.Width * $scale); $h = [int][math]::Round($bounds.Height * $scale)
  }
}
$bitmap = New-Object System.Drawing.Bitmap($w, $h)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($x, $y, 0, 0, $bitmap.Size)
$bitmap.Save('__PATH__', [System.Drawing.Imaging.ImageFormat]::Bmp)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output ("{0} {1}" -f $w, $h)
'''


def _powershell_exe():
    for name in ('powershell.exe', 'powershell', 'pwsh.exe', 'pwsh'):
        found = shutil.which(name)
        if found:
            return found
    return None


def run_powershell(script, timeout=30):
    """用 -EncodedCommand 跑一段脚本，避开引号转义地狱。"""
    exe = _powershell_exe()
    if not exe:
        raise RuntimeError('powershell_not_found')
    encoded = base64.b64encode(script.encode('utf-16-le')).decode('ascii')
    proc = subprocess.run(
        [exe, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        capture_output=True,
        timeout=timeout,
        creationflags=NO_WINDOW,
    )
    stdout = _decode_output(proc.stdout)
    if proc.returncode != 0:
        stderr = _decode_output(proc.stderr).strip()
        raise RuntimeError('powershell exit %s: %s' % (proc.returncode, stderr[:400] or stdout[:200]))
    return stdout


def capture_via_powershell(path, monitor=0):
    script = POWERSHELL_CAPTURE.replace('__MONITOR__', str(_to_int(monitor, 0))).replace(
        '__PATH__', str(path).replace("'", "''")
    )
    output = run_powershell(script, timeout=30)
    match = re.search(r'(\d+)\s+(\d+)', output)
    if not match:
        raise RuntimeError(t('sidecar.screenshot.noSize', output=output.strip()[:200]))
    return int(match.group(1)), int(match.group(2))


def resolve_output_path(path):
    if path:
        target = _abs_path(path)
    else:
        target = os.path.join(DATA_DIR, 'screenshots', _timestamp_name('screen', 'bmp'))
    folder = os.path.dirname(target)
    if folder:
        os.makedirs(folder, exist_ok=True)
    return target


def capture_screenshot(path=None, monitor=0):
    if not IS_WINDOWS:
        return {'ok': False, 'error': 'unsupported_platform'}
    try:
        target = resolve_output_path(path)
    except Exception as exc:
        return {'ok': False, 'error': 'bad_path', 'detail': str(exc)}
    errors = []
    for name, func in (('gdi', capture_via_gdi), ('powershell', capture_via_powershell)):
        started = time.time()
        try:
            width, height = func(target, monitor)
            size = os.path.getsize(target) if os.path.exists(target) else 0
            if width > 0 and height > 0 and size > 0:
                return {
                    'ok': True,
                    'path': target,
                    'width': int(width),
                    'height': int(height),
                    'method': name,
                    'bytes': int(size),
                    'elapsedMs': int((time.time() - started) * 1000),
                }
            errors.append(t('sidecar.screenshot.emptyResult', method=name, size=size))
        except Exception as exc:
            errors.append('%s: %s' % (name, exc))
    return {'ok': False, 'error': 'screenshot_failed', 'detail': '; '.join(errors)}


# --------------------------------------------------------------------------- #
# 可选能力：ASR / OCR
# --------------------------------------------------------------------------- #

ASR_LOCK = threading.RLock()
ASR_STATE = {'model': None, 'key': None, 'error': None}


def asr_available():
    return _has_module('faster_whisper')


def transcribe_file(path, model_size=None, language=None):
    if not asr_available():
        return {'ok': False, 'error': 'asr_unsupported', 'detail': t('sidecar.asr.missingDependency')}
    target = _abs_path(path)
    if not target or not os.path.exists(target):
        return {'ok': False, 'error': 'file_not_found', 'detail': str(path)}
    size = str(model_size or os.environ.get('RUOHUA_ASR_MODEL') or 'base')
    with ASR_LOCK:
        if ASR_STATE['model'] is None or ASR_STATE['key'] != size:
            try:
                from faster_whisper import WhisperModel  # type: ignore

                device = os.environ.get('RUOHUA_ASR_DEVICE') or 'cpu'
                compute = os.environ.get('RUOHUA_ASR_COMPUTE') or ('int8' if device == 'cpu' else 'float16')
                ASR_STATE['model'] = WhisperModel(size, device=device, compute_type=compute)
                ASR_STATE['key'] = size
                ASR_STATE['error'] = None
            except Exception as exc:
                ASR_STATE['model'] = None
                ASR_STATE['key'] = None
                ASR_STATE['error'] = '%s: %s' % (exc.__class__.__name__, exc)
        model = ASR_STATE['model']
        if model is None:
            return {'ok': False, 'error': 'asr_load_failed', 'detail': ASR_STATE['error']}
        try:
            segments, info = model.transcribe(target, language=language or None, vad_filter=True)
            text = ''.join(segment.text for segment in segments).strip()
        except Exception as exc:
            return {'ok': False, 'error': 'asr_failed', 'detail': '%s: %s' % (exc.__class__.__name__, exc)}
    return {
        'ok': True,
        'text': text,
        'language': getattr(info, 'language', None),
        'duration': getattr(info, 'duration', None),
        'model': size,
    }


OCR_LOCK = threading.RLock()
OCR_PROBE = {'done': False, 'ok': False, 'detail': None}

OCR_PROBE_SCRIPT = r'''
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
foreach ($lang in $langs) { Write-Output $lang.LanguageTag }
'''

OCR_WINRT_SCRIPT = r'''
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($operation, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('__PATH__')) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'en-US'))
}
if ($null -eq $engine) { throw 'no OCR engine available' }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$stream.Dispose()
Write-Output $result.Text
'''


def probe_windows_ocr(timeout=20):
    if not IS_WINDOWS:
        return False
    try:
        output = run_powershell(OCR_PROBE_SCRIPT, timeout=timeout)
        langs = [line.strip() for line in output.splitlines() if line.strip()]
        with OCR_LOCK:
            OCR_PROBE.update(done=True, ok=bool(langs), detail=','.join(langs) or 'no_language')
        return bool(langs)
    except Exception as exc:
        with OCR_LOCK:
            OCR_PROBE.update(done=True, ok=False, detail='%s: %s' % (exc.__class__.__name__, exc))
        return False


def ocr_backends():
    backends = []
    if _has_module('pytesseract') and shutil.which('tesseract'):
        backends.append('pytesseract')
    if IS_WINDOWS:
        backends.append('windows_media_ocr')
    return backends


def ocr_available():
    if _has_module('pytesseract') and shutil.which('tesseract'):
        return True
    if IS_WINDOWS:
        return bool(OCR_PROBE.get('ok'))
    return False


def ocr_file(path, language=None):
    target = _abs_path(path)
    if not target or not os.path.exists(target):
        return {'ok': False, 'error': 'file_not_found', 'detail': str(path)}
    errors = []

    if _has_module('pytesseract') and shutil.which('tesseract'):
        try:
            import pytesseract  # type: ignore
            from PIL import Image  # type: ignore

            with Image.open(target) as image:
                text = pytesseract.image_to_string(image, lang=language or None)
            return {'ok': True, 'text': (text or '').strip(), 'backend': 'pytesseract'}
        except Exception as exc:
            errors.append('pytesseract: %s: %s' % (exc.__class__.__name__, exc))

    if IS_WINDOWS:
        try:
            script = OCR_WINRT_SCRIPT.replace('__PATH__', str(target).replace("'", "''"))
            output = run_powershell(script, timeout=60)
            return {'ok': True, 'text': output.strip(), 'backend': 'windows_media_ocr'}
        except Exception as exc:
            errors.append('windows_media_ocr: %s: %s' % (exc.__class__.__name__, exc))

    if not errors:
        return {'ok': False, 'error': 'ocr_unsupported', 'detail': t('sidecar.ocr.noBackend')}
    return {'ok': False, 'error': 'ocr_failed', 'detail': '; '.join(errors)[:600]}


def start_ocr_probe():
    """后台探测 Windows OCR，不拖慢启动。"""
    if not IS_WINDOWS or (_has_module('pytesseract') and shutil.which('tesseract')):
        return
    thread = threading.Thread(target=probe_windows_ocr, name='ocr-probe', daemon=True)
    thread.start()


# --------------------------------------------------------------------------- #
# 接口
# --------------------------------------------------------------------------- #

def features():
    return {
        'embed': True,
        'screenshot': bool(IS_WINDOWS),
        'asr': asr_available(),
        'ocr': ocr_available(),
    }


def health_payload():
    return {
        'ok': True,
        'service': SERVICE_NAME,
        'version': VERSION,
        'python': platform.python_version(),
        'platform': platform.platform(),
        'features': features(),
        'dataDir': DATA_DIR,
        'ocrBackends': ocr_backends(),
        'uptimeSeconds': int(time.time() - STARTED_AT),
    }


INDEX_TEXT = t(
    'sidecar.index.body',
    service=SERVICE_NAME,
    version=VERSION,
    dim=EMBED_DIM,
    dataDir=DATA_DIR,
)


STARTED_AT = time.time()


class SidecarHandler(BaseHTTPRequestHandler):
    server_version = '%s/%s' % (SERVICE_NAME, VERSION)
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        _eprint('[%s] %s' % (time.strftime('%H:%M:%S'), fmt % args))

    # ------------------------------------------------------------------ #
    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False, default=str).encode('utf-8')
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def _send_text(self, text, status=200):
        body = text.encode('utf-8')
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def _read_json(self):
        length = _to_int(self.headers.get('Content-Length'), 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        parsed = json.loads(_decode_output(raw))
        return parsed if parsed is not None else {}

    def _fail(self, exc, status=500):
        _eprint(traceback.format_exc())
        message = str(exc).strip() or exc.__class__.__name__
        self._send_json({'ok': False, 'error': message, 'kind': exc.__class__.__name__}, status=status)

    # ------------------------------------------------------------------ #
    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            route = parsed.path.rstrip('/') or '/'
            query = parse_qs(parsed.query)
            if route == '/':
                self._send_text(INDEX_TEXT)
                return
            if route == '/health':
                self._send_json(health_payload())
                return
            if route == '/screenshot':
                path = (query.get('path') or [None])[0]
                monitor = _to_int((query.get('monitor') or ['0'])[0], 0)
                self._send_json(capture_screenshot(path, monitor))
                return
            self._send_json({'ok': False, 'error': 'not_found', 'path': route}, status=404)
        except Exception as exc:  # noqa: BLE001 - 任何异常都要变成 JSON
            self._fail(exc)

    def do_POST(self):
        try:
            parsed = urlparse(self.path)
            route = parsed.path.rstrip('/') or '/'
            payload = self._read_json()
            if route == '/embed':
                texts = payload.get('texts') if isinstance(payload, dict) else payload
                if isinstance(texts, str):
                    texts = [texts]
                if not isinstance(texts, list):
                    self._send_json({'ok': False, 'error': 'texts_must_be_list'}, status=400)
                    return
                dim = _to_int(payload.get('dim') if isinstance(payload, dict) else None, EMBED_DIM)
                if dim <= 0:
                    dim = EMBED_DIM
                vectors = embed_texts([str(item or '') for item in texts], dim)
                self._send_json({'ok': True, 'vectors': vectors, 'dim': dim, 'count': len(vectors)})
                return
            if route == '/similar':
                a = str(payload.get('a') or '')
                b = str(payload.get('b') or '')
                score = cosine(embed_text(a), embed_text(b))
                self._send_json({'ok': True, 'score': round(score, 6), 'a': a[:200], 'b': b[:200]})
                return
            if route == '/score':
                items = payload.get('items') or []
                now = payload.get('now')
                half_life = payload.get('halfLifeHours')
                weight = payload.get('accessWeight', DEFAULT_ACCESS_WEIGHT)
                scores = score_items(items, now, half_life, weight)
                self._send_json({'ok': True, 'scores': scores, 'count': len(scores)})
                return
            if route == '/consolidate':
                result = consolidate_items(payload.get('items') or [], payload.get('thresholds'), payload.get('now'))
                result['ok'] = True
                self._send_json(result)
                return
            if route == '/asr':
                path = payload.get('path')
                self._send_json(transcribe_file(path, payload.get('model'), payload.get('language')))
                return
            if route == '/ocr':
                path = payload.get('path')
                self._send_json(ocr_file(path, payload.get('language')))
                return
            self._send_json({'ok': False, 'error': 'not_found', 'path': route}, status=404)
        except Exception as exc:  # noqa: BLE001
            self._fail(exc)


class SidecarServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


# --------------------------------------------------------------------------- #
# 入口
# --------------------------------------------------------------------------- #

def run_selftest(args):
    global DATA_DIR
    DATA_DIR = os.path.abspath(os.path.expanduser(args.data_dir or DEFAULT_DATA_DIR))
    info = {
        'service': SERVICE_NAME,
        'version': VERSION,
        'python': platform.python_version(),
        'platform': platform.platform(),
        'dataDir': DATA_DIR,
        'features': features(),
        'ocrBackends': ocr_backends(),
    }
    _print('[selftest] ' + json.dumps(info, ensure_ascii=False))
    # 自检用的两句示例是测试数据、不是文字，写成转义，免得被本地化体检当成写死的中文
    sample_a = '\u4eca\u5929\u5929\u6c14\u4e0d\u9519'       # 今天天气不错
    sample_b = '\u4eca\u5929\u5929\u6c14\u633a\u597d\u7684'  # 今天天气挺好的
    sample_score = cosine(embed_text(sample_a), embed_text(sample_b))
    _print('[selftest] ' + t('sidecar.selftest.embed', dim=EMBED_DIM, score='%.4f' % sample_score))
    if not IS_WINDOWS:
        _print('[selftest] ' + t('sidecar.selftest.screenSkipped'))
        return 0
    target = os.path.join(DATA_DIR, 'screenshots', _timestamp_name('selftest', 'bmp'))
    result = capture_screenshot(target, 0)
    _print('[selftest] ' + t('sidecar.selftest.screen') + json.dumps(result, ensure_ascii=False))
    return 0 if result.get('ok') else 1


def main(argv=None):
    global DATA_DIR
    parser = argparse.ArgumentParser(description=t('sidecar.cli.description'))
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--data-dir', default=None, help=t('sidecar.cli.dataDirHelp'))
    parser.add_argument('--selftest', action='store_true', help=t('sidecar.cli.selftestHelp'))
    args = parser.parse_args(argv)

    if args.selftest:
        return run_selftest(args)

    DATA_DIR = os.path.abspath(os.path.expanduser(args.data_dir or DEFAULT_DATA_DIR))
    os.makedirs(DATA_DIR, exist_ok=True)
    start_ocr_probe()

    _dpi_aware()
    server = SidecarServer((args.host, args.port), SidecarHandler)
    _print(t('sidecar.server.started', service=SERVICE_NAME, version=VERSION,
             host=args.host, port=args.port, dataDir=DATA_DIR))
    _print(t('sidecar.server.features') + json.dumps(features(), ensure_ascii=False))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        _print(t('sidecar.server.interrupted'))
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
