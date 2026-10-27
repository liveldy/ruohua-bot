#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""若华 · Python 侧的本地化读取器（与 JS 侧共用同一批本地化键）。

文字放在 src/i18n/locales/zh-CN/<命名空间>.json（文件名即命名空间，扁平键，
占位符写 {名字}）；管理员在控制面板改过的文字覆盖在 <root>/data/locales/zh-CN.json，
只写与默认不同的键，覆盖优先于默认。

    from i18n import t, configure

    configure(root_dir)                            # 可选：挂上 <root>/data/locales/zh-CN.json
    t('sidecar.server.started', host='127.0.0.1')  # 模块顶层就能调

规矩：
  - 默认文字目录按本文件位置定位（<仓库根>/src/i18n/locales/zh-CN），不写死绝对路径；
  - 找不到键就返回键本身；
  - 覆盖文件不在、读不动、JSON 坏了都不抛错，退回默认文字；
  - 只用标准库。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

LOCALE = 'zh-CN'

# 默认文字目录：<仓库根>/src/i18n/locales/<语言>
LOCALE_ROOT = Path(__file__).resolve().parent.parent / 'src' / 'i18n' / 'locales'
DEFAULT_LOCALE_DIR = LOCALE_ROOT / LOCALE

PLACEHOLDER_RE = re.compile(r'\{(\w+)\}')

_state = {'table': None}


def _read_object(path):
    """读一个 JSON 对象；文件不在、读不动、解析不了都返回 None。"""
    if path is None:
        return None
    try:
        raw = Path(path).read_text(encoding='utf-8')
    except (OSError, ValueError):
        return None
    if not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _load_defaults(locale):
    """目录下每个 <命名空间>.json 合成一张扁平表，只收属于该命名空间的字符串键。"""
    table = {}
    directory = LOCALE_ROOT / locale if locale else DEFAULT_LOCALE_DIR
    try:
        files = sorted(directory.glob('*.json'))
    except OSError:
        return table
    for file in files:
        content = _read_object(file)
        if not content:
            continue
        prefix = file.stem + '.'
        for key, value in content.items():
            if not key.startswith(prefix) or not isinstance(value, str):
                continue
            table.setdefault(key, value)
    return table


def configure(root_dir=None, locale=LOCALE):
    """挂上覆盖文件 <root_dir>/data/locales/<语言>.json，并与默认文字合成一张表。

    root_dir 不给就只用代码自带的默认文字。返回生效中的那张表。
    """
    override_file = None
    if root_dir:
        override_file = Path(root_dir).resolve() / 'data' / 'locales' / ('%s.json' % locale)
    table = _load_defaults(locale)
    overrides = _read_object(override_file)
    if overrides:
        for key, value in overrides.items():
            if isinstance(value, str):
                table[key] = value
    _state['table'] = table
    return table


def _table():
    """当前生效的本地化键表；没配过就用代码自带的那份（t() 在模块顶层也能用）。"""
    table = _state['table']
    if table is None:
        table = configure()
    return table


def t(key, **params):
    """取文字；找不到就返回键本身。占位符 {名字} 用关键字参数填，没有对应参数就原样留着。"""
    name = str(key if key is not None else '')
    text = _table().get(name)
    if text is None:
        return name
    if not params:
        return text
    return PLACEHOLDER_RE.sub(
        lambda match: str(params[match.group(1)]) if match.group(1) in params else match.group(0),
        text,
    )
