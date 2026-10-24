#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/_home.py —— Python 脚本**唯一**的家目录来源
============================================================================
为什么要有这个文件：
  2026-10-22 之前，5 个 .py 各自写死了一个绝对路径（D 盘某个目录）。
  那是"某台机器上的脚本"，不是插件 —— 换台设备会静默回落到一个不存在的 D 盘，
  然后报一个跟真实原因毫无关系的 ENOENT。

规矩：
  ① 只认环境变量 `DOUYIN_HOME`（宿主 index.js 会注入）。
  ② 没有就退到 `DSH_HOME/douyin-duty`、再退 `~/.dsh/douyin-duty`。
  ③ **绝不**写死任何盘符。全都没有就抛错，让人一眼看出是配置问题。
============================================================================
"""
from __future__ import annotations

import os
from pathlib import Path


def home_dir(create: bool = True) -> Path:
    """插件家目录。没有 DOUYIN_HOME 也不写死盘符，按 DSH 约定往下退。"""
    env = (os.environ.get("DOUYIN_HOME") or "").strip()
    if env:
        p = Path(env)
    else:
        dsh = (os.environ.get("DSH_HOME") or "").strip()
        p = (Path(dsh) if dsh else Path.home() / ".dsh") / "douyin-duty"
    if create:
        p.mkdir(parents=True, exist_ok=True)
    return p


def home_str(create: bool = True) -> str:
    return str(home_dir(create))


def cookie_file() -> Path:
    return home_dir() / "douyin_cookie.txt"


def plugin_dir() -> Path:
    """插件包根目录（tools/ 的上一层）"""
    return Path(__file__).resolve().parent.parent


def node_bin() -> str:
    return os.environ.get("DOUYIN_NODE") or "node"
