#!/usr/bin/env python3
"""
抖音无水印视频下载 + 文案/画面双线分析工具 (v3.2)

双线流水线：
  音频线: 取得视频 → 提取音频 → faster-whisper 本地 ASR（CUDA 优先，失败自动降 CPU）
  视觉线: 取得视频 → FFmpeg 抽帧 → 产出帧图列表供视觉模型扫画面文字

v3.2 相对 v3.1 的改动（都是为了让"新会话直接能用、不卡住"）：
1. 自举：自动把「依赖根目录/python」加进 sys.path；解释器版本不匹配时
   自动 re-exec 到匹配的 3.11（无需宿主预设任何环境变量）。
   依赖根目录的找法见 _default_deps_root()：环境变量 → 插件旁边的 _deps → ~/.dsh/deps。
2. 模型预置：优先用「依赖根目录/models/faster-whisper-*」本地目录（只读也能用），
   免去每次下载 ~460MB；没有预置时才回落到 HF 下载，且 HF_HOME 自动选可写目录。
3. DLL：cuBLAS/cuDNN 目录多路径探测（ctranslate2 包内、nvidia pip 包、CUDA_PATH、
   NVIDIA Toolkit v*，含 glob），不再假设恰好装在 PATH 里。
4. 取流策略链（逐级降级，全部有超时，失败快速退出而不是挂住）：
     router_data → yt-dlp → yt-dlp+cookies → 无登录 headless Chrome（playwright-core）
   最后还有显式入口兜底：--url/--audio-url（媒体直链）、--video（本地文件）。
5. 分片流（DASH）自动合并：拿到 video+audio 两条直链时用 ffmpeg -c copy 合轨。
6. ASR 设备自动降级：CUDA(int8_float16) 失败自动重试 CPU(int8)，结果里回报实际设备。
7. 失败信息可执行化：把 yt-dlp 的 "Fresh cookies ... are needed" 等翻译成明确的三条出路。
8. 控制台 UTF-8 修正，避免 Windows 下中文乱码/UnicodeEncodeError。

环境要求：Python 3.11（脚本会自己找）、FFmpeg、依赖根目录里的第三方包；GPU 可选。
"""

from __future__ import annotations

import argparse
import atexit
import glob
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

# ============================================================================
# 0. 自举：依赖路径 / 解释器 / 模型缓存 / DLL（必须在第三方 import 之前）
# ============================================================================

def _default_deps_root() -> Path:
    """依赖根目录怎么找。

    2026-11-17：不再写死本机绝对路径（公开包里不该出现 `D:\\某人的目录\\_deps`）。
    顺序：
      ① 环境变量 DOUYIN_DEPS_ROOT（宿主 / 老用户可以用它指到任何地方）
      ② **插件旁边的 _deps**：插件装在 <plugins>/dsh-douyin-watch 时，这里就是 <plugins>/_deps
         —— 和"依赖跟插件放一起"的机器布局一致，换台机器、换个盘符都成立
      ③ ~/.dsh/deps（全新机器，什么都没有时的落脚点）
    """
    env = str(os.environ.get('DOUYIN_DEPS_ROOT') or '').strip()
    if env:
        return Path(env)
    try:
        sibling = Path(__file__).resolve().parents[2].parent / '_deps'
        if sibling.is_dir():
            return sibling
    except Exception:
        pass
    return Path.home() / '.dsh' / 'deps'


_DEPS_ROOT = _default_deps_root()
_DEPS_PY = Path(os.environ.get('DOUYIN_DEPS_DIR', str(_DEPS_ROOT / 'python')))
_SKILL_DIR = Path(__file__).resolve().parent
_DEFAULT_MODEL = os.environ.get('DOUYIN_MODEL', 'small')

# ── 中文 ASR（Paraformer，纯 CPU，ONNX）──
#   实测（2026-11-17，同一条片子，纯 CPU）：whisper small 112s → paraformer 16.7s，
#   而且自带标点。整段喂进去会失败（40 分钟那条直接 0 字），必须分片。
_CN_CHUNK_SEC = float(os.environ.get('DOUYIN_CN_CHUNK', '30'))
_CN_ASR_DIR = os.environ.get('DOUYIN_CN_ASR_DIR', str(_DEPS_ROOT / 'funasr-onnx'))
_CN_MODEL_CACHE = os.environ.get('DOUYIN_CN_MODEL_CACHE', str(_DEPS_ROOT / 'models' / 'modelscope'))
_CN_PARA = os.environ.get('DOUYIN_CN_ASR_MODEL',
                          'damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx')
_CN_PUNC = os.environ.get('DOUYIN_CN_PUNC_MODEL',
                          'damo/punc_ct-transformer_zh-cn-common-vocab272727-onnx')


def _cn_asr_ok_in(d) -> bool:
    """这个目录里是不是**一套完整的** funasr_onnx。

    2026-11-17：以前只看 `funasr_onnx` 目录在不在。pip 装到一半被打断（超时 / 断网 / 进程被杀）
    也会留下这个目录，于是被判成"已装"——之后每次 import 都失败，而且再也不会重装，
    用户只能自己去删目录。现在要求「包目录 + 它自己的 dist-info」都在。
    """
    try:
        p = Path(d)
        if not (p / 'funasr_onnx' / '__init__.py').is_file():
            return False
        return bool(list(p.glob('funasr_onnx-*.dist-info')) or list(p.glob('funasr-onnx-*.dist-info')))
    except Exception:
        return False


def _cn_asr_ready() -> str:
    """返回能找到**完整** funasr_onnx 的目录；找不到返回空串。"""
    for d in (_CN_ASR_DIR, str(_DEPS_PY)):
        if d and _cn_asr_ok_in(d):
            return d
    return ''


def _ensure_cn_deps(show_progress: bool = True) -> str:
    """保证中文引擎装好；缺了就自己装一次（不要求用户预装、也不再靠 whisper 兜底）。

    2026-11-17 加固（三个理由）：
      ① pip 没有超时 → 网络卡住会把整次分析拖到 8 分钟超时；
      ② 直接往正式目录装 → 装一半被打断就留下"看着像装好"的残缺目录；
      ③ 用户自己指定的目录不能乱删。
    所以：装到 `<正式目录>.installing` 的暂存目录，**校验通过后**才替换正式目录
    （同一块盘上的 rename 是原子的）；失败就整个删掉暂存目录，正式目录一个字节都不动。
    """
    ready = _cn_asr_ready()
    if ready:
        return ready
    if os.environ.get('DOUYIN_CN_NO_INSTALL') == '1':
        return ''

    target = Path(_CN_ASR_DIR)
    staging = Path(str(target) + '.installing')
    custom = bool(str(os.environ.get('DOUYIN_CN_ASR_DIR') or '').strip())
    if custom and target.exists():
        # 用户自己指了目录、里面还有别的东西 → 绝不动它，只给可执行的提示
        print(f'中文引擎不可用：{target} 里没有完整的 funasr_onnx。\n'
              f'  手动装：pip install --target "{target}" funasr-onnx modelscope\n'
              '  或者去掉 DOUYIN_CN_ASR_DIR，让插件自己装到默认目录。')
        return ''

    _drop(staging)
    if show_progress:
        print('首次使用：正在下载转写引擎（funasr-onnx + modelscope，约 500 MB，只下这一次，之后不再下载）…')
    try:
        rc = subprocess.call(
            [sys.executable, '-m', 'pip', 'install', '--no-input', '--target', str(staging),
             '-q', 'funasr-onnx', 'modelscope',
             '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'],
            timeout=420)
    except subprocess.TimeoutExpired:
        print('下载引擎超时（超过 7 分钟）—— 网络慢的话稍后再试一次，装好之后就不会再下了。')
        _drop(staging)
        return ''
    except Exception as e:  # noqa: BLE001
        print(f'安装失败：{e}')
        _drop(staging)
        return ''
    if rc != 0:
        print(f'安装失败（pip rc={rc}）—— 网络问题的话稍后再试一次。')
        _drop(staging)
        return ''
    if not _cn_asr_ok_in(staging):
        print('装完了但校验没通过（只装了一半），已清掉，稍后再试一次。')
        _drop(staging)
        return ''
    try:
        if target.exists():
            # 不删：留着可能是用户自己装的残缺目录，改名备份，出问题还能找回来
            backup = Path(str(target) + '.broken-' + time.strftime('%Y%m%d-%H%M%S'))
            try:
                os.replace(str(target), str(backup))
                print(f'旧目录不完整，已改名备份：{backup.name}')
            except Exception:
                _drop(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.replace(str(staging), str(target))          # 同盘：原子
        except Exception:
            shutil.move(str(staging), str(target))         # 跨盘：退一步
    except Exception as e:  # noqa: BLE001
        print(f'安装成功但落地失败：{e}')
        _drop(staging)
        return ''
    return _cn_asr_ready()


def _drop(p: Path) -> None:
    """删一个目录（只用于我们自己创建的暂存目录 / 已确定是残缺的正式目录）。"""
    try:
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
    except Exception:
        pass


def _reconfigure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')  # type: ignore[attr-defined]
        except Exception:
            pass


def _required_py_tag() -> Optional[str]:
    """从依赖目录里的编译扩展推断需要的 CPython 版本标签（如 cp311）。"""
    # 先看几个必然会出现的包，避免在大目录上全量扫描
    for probe in ('numpy/_core', 'ctranslate2', 'tokenizers', 'onnxruntime/capi', 'av'):
        try:
            for pyd in (_DEPS_PY / probe).glob('*.cp3*-win_amd64.pyd'):
                m = re.search(r'\.(cp3\d+)-win_amd64\.pyd$', pyd.name)
                if m:
                    return m.group(1)
        except Exception:
            continue
    try:
        for pyd in _DEPS_PY.rglob('*.cp3*-win_amd64.pyd'):
            m = re.search(r'\.(cp3\d+)-win_amd64\.pyd$', pyd.name)
            if m:
                return m.group(1)
    except Exception:
        pass
    return None


def _find_interpreter(tag: Optional[str]) -> Optional[str]:
    """找一个满足版本标签的解释器（stdlib only，绝不 import 第三方）。"""
    if not tag:
        return None
    want = (int(tag[2]), int(tag[3:]))
    want_str = f'{want[0]}.{want[1]}'
    candidates: List[str] = []
    if os.environ.get('DOUYIN_PYTHON'):
        candidates.append(os.environ['DOUYIN_PYTHON'])
    patterns = [
        str(_DEPS_ROOT / f'python{want[0]}{want[1]}' / f'cpython-{want_str}*' / 'python.exe'),
    ]
    # 2026-11-18：这几条是 Windows 专有的安装位置（C:/Program Files…），
    #   放到非 Windows 上只会白 glob 一圈。按平台分开写，别让别的系统跟着猜。
    if sys.platform == 'win32':
        patterns += [
            str(Path(os.environ.get('APPDATA', '')) / 'uv' / 'python' / f'cpython-{want_str}*' / 'python.exe'),
            str(Path(os.environ.get('LOCALAPPDATA', '')) / 'uv' / 'python' / f'cpython-{want_str}*' / 'python.exe'),
            f'C:/Program Files/Python{want[0]}{want[1]}/python.exe',
            f'C:/Python{want[0]}{want[1]}/python.exe',
            str(Path.home() / f'AppData/Local/Programs/Python/Python{want[0]}{want[1]}/python.exe'),
        ]
    else:
        patterns += [
            f'/usr/bin/python{want_str}', f'/usr/local/bin/python{want_str}',
            f'/opt/homebrew/bin/python{want_str}',
            str(Path.home() / '.local' / 'bin' / f'python{want_str}'),
            str(Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local' / 'share'))) / 'uv' / 'python' / f'cpython-{want_str}*' / 'bin' / 'python3'),
        ]
    for p in patterns:
        candidates.extend(glob.glob(p))
    for exe in (f'python{want_str}', f'python{want[0]}{want[1]}'):
        w = shutil.which(exe)
        if w:
            candidates.append(w)
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None


def _bootstrap() -> None:
    """保证 sys.path 指向 _deps\\python，并让解释器版本与之匹配。"""
    _reconfigure_stdio()
    tag = _required_py_tag()
    cur = f'cp{sys.version_info[0]}{sys.version_info[1]}'
    needs_switch = bool(tag) and tag != cur and sys.version_info[:2] != (3, 11)

    if needs_switch and not os.environ.get('DOUYIN_REEXEC'):
        exe = _find_interpreter(tag)
        # 重新执行"调用者的入口脚本"（CLI 场景下就是本文件；被 import 时是调用者的脚本），
        # 这样 `python 任意脚本.py` 里 import 本模块也能自动切到 3.11。
        entry = None
        if sys.argv and sys.argv[0] and os.path.isfile(sys.argv[0]):
            entry = os.path.abspath(sys.argv[0])
        if exe and entry:
            env = dict(os.environ)
            env['DOUYIN_REEXEC'] = '1'
            env['PYTHONIOENCODING'] = 'utf-8'
            env['PYTHONPATH'] = os.pathsep.join(
                [str(_DEPS_PY)] + ([env['PYTHONPATH']] if env.get('PYTHONPATH') else []))
            print(f'[自举] 依赖目录需要 {tag}，当前是 {cur}；改用 {exe} 重新执行 {Path(entry).name}…',
                  flush=True)
            try:
                rc = subprocess.call([exe, entry, *sys.argv[1:]], env=env)
            except KeyboardInterrupt:
                sys.exit(130)
            sys.exit(rc)

    if _DEPS_PY.is_dir():
        p = str(_DEPS_PY)
        if p not in sys.path:
            sys.path.insert(0, p)


_bootstrap()

try:
    import ffmpeg  # noqa: E402,F401
    import requests  # noqa: E402
    from requests.adapters import HTTPAdapter  # noqa: E402
    from urllib3.util.retry import Retry  # noqa: E402
except ModuleNotFoundError as _imp_err:  # 自举没接上时给出可执行提示，而不是甩 traceback
    print(f'[环境错误] 缺少依赖 {_imp_err.name}。\n'
          f'  依赖目录: {_DEPS_PY}（存在={_DEPS_PY.is_dir()}）\n'
          f'  当前解释器: {sys.executable} ({sys.version.split()[0]})\n'
          f'  修复：确认 {_DEPS_PY} 里是给当前解释器编译的包，或设 DOUYIN_DEPS_DIR / DOUYIN_PYTHON。',
          file=sys.stderr)
    sys.exit(2)

# ============================================================================
# 1. 配置
# ============================================================================

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9',
}
MOBILE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 '
                  '(KHTML, like Gecko) EdgiOS/121.0.2277.107 Version/17.0 Mobile/15E148 Safari/604.1'
}
URL_RE = re.compile(r'http[s]?://(?:[a-zA-Z]|[0-9]|[$-_@.&+]|[!*\(\),]|(?:%[0-9a-fA-F][0-9a-fA-F]))+')
_VIDEO_CT_PREFIXES = ('video/', 'audio/', 'application/octet-stream',
                      'application/x-mpegurl', 'application/vnd.apple.mpegurl')
_REFERER = 'https://www.douyin.com/'
_BROWSER_HELPER = _SKILL_DIR / 'fetch_media_urls.mjs'

# 退出码
EXIT_OK = 0
EXIT_ENV = 2
EXIT_RESOLVE = 3
EXIT_ASR = 4

COOKIE_HINT = (
    '抖音拒绝了匿名接口请求。三条出路（任选其一）：\n'
    '  1) 关掉浏览器后重试：--cookies-from-browser chrome\n'
    '  2) 浏览器扩展导出 douyin.com 的 cookies.txt：--cookies path\\to\\cookies.txt\n'
    '  3) 自己下好视频后本地分析（永不被风控）：--video D:\\path\\video.mp4\n'
    '     或把浏览器里的媒体直链直接喂进来：--url "<media url>" [--audio-url "<audio url>"]'
)


class ResolveError(RuntimeError):
    """取流失败（带可执行建议）。"""

    def __init__(self, message: str, hint: str = COOKIE_HINT):
        super().__init__(message)
        self.hint = hint


# ----------------------------------------------------------------------------
# 4.9 cookies 文件：先自己判格式，绝不把内容交给 yt-dlp 去打日志
# ----------------------------------------------------------------------------
# ⚠️ 2026-11-18 实测事故：`--cookies douyin_cookie.txt`（那是插件自己存的一整行原始
#   cookie 串、不是 Netscape 格式）会让 yt-dlp 回
#     skipping cookie file entry due to invalid length 1: '<整个文件内容>'
#   —— 整串 cookie 连 sessionid 一起被打到 stdout/stderr 上（等于把账号所有权泄了）。
#   从这里开始：非 Netscape 的文件先在这里转换；转不了就明确拒绝，**一个字符都不回显**。

_COOKIE_TAB_FIELDS = 7


def _looks_netscape_cookie_file(text: str) -> bool:
    """有任意一行是 7 个 tab 字段的，就算 Netscape 格式。"""
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith('#'):
            continue
        if len(s.split('\t')) == _COOKIE_TAB_FIELDS:
            return True
    return False


def _looks_raw_cookie_header(text: str) -> bool:
    """`k=v; k2=v2` 这种一整行原始 cookie（插件自己的 douyin_cookie.txt 就是）。"""
    s = text.strip()
    if not s or '\t' in s or '\n' in s:
        return False
    return ('=' in s) and (';' in s)


def _cookies_to_netscape(path: str) -> str:
    """把 `--cookies` 指过来的文件整理成 yt-dlp 认的 Netscape 格式，返回可用路径。

    绝不把 cookie 内容写进任何异常信息或日志（只报路径/条数之外的判断结果）。
    """
    p = Path(str(path))
    if not p.exists():
        raise ResolveError('--cookies 指的文件不存在', hint=COOKIE_HINT)
    try:
        text = p.read_text(encoding='utf-8', errors='ignore')
    except OSError:
        raise ResolveError('--cookies 指的文件读不了（权限或编码问题）', hint=COOKIE_HINT) from None

    if _looks_netscape_cookie_file(text):
        return str(p)

    if not _looks_raw_cookie_header(text):
        raise ResolveError(
            '--cookies 需要 Netscape 格式的 cookies.txt（每行 7 个 tab 字段）。'
            '这个文件看起来不是，已中止；为了安全，没有把文件内容打印出来。',
            hint=COOKIE_HINT,
        )

    lines = ['# Netscape HTTP Cookie File']
    for part in text.strip().split(';'):
        kv = part.strip()
        if '=' not in kv:
            continue
        name, value = kv.split('=', 1)
        name, value = name.strip(), value.strip()
        if not name or not value:
            continue
        lines.append('\t'.join(['.douyin.com', 'TRUE', '/', 'TRUE', '1799999999', name, value]))
    if len(lines) <= 1:
        raise ResolveError('--cookies 文件里没解析出任何 cookie 键值对，已中止', hint=COOKIE_HINT)

    tmp = Path(tempfile.gettempdir()) / f'dy-cookies-{os.getpid()}-{int(time.time())}.txt'
    try:
        tmp.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    except OSError:
        raise ResolveError('转换 cookies 到临时文件失败', hint=COOKIE_HINT) from None
    _TEMP_COOKIE_FILES.append(str(tmp))
    return str(tmp)


_TEMP_COOKIE_FILES: List[str] = []


def _cleanup_temp_cookies() -> None:
    """用完就删（里面是真凭据，别留在磁盘上）。"""
    while _TEMP_COOKIE_FILES:
        f = _TEMP_COOKIE_FILES.pop()
        try:
            os.remove(f)
        except OSError:
            pass


atexit.register(_cleanup_temp_cookies)


# ============================================================================
# 2. 环境落地：模型缓存 / DLL
# ============================================================================

def _preinstalled_model_dir(model_name: str) -> Optional[Path]:
    for cand in (_DEPS_ROOT / 'models' / f'faster-whisper-{model_name}',
                 _DEPS_ROOT / 'models' / model_name):
        if (cand / 'model.bin').exists():
            return cand
    return None


def _pick_writable_dir(cands: List[Path], marker: str = '.wtest') -> Optional[Path]:
    for c in cands:
        try:
            c.mkdir(parents=True, exist_ok=True)
            probe = c / marker
            probe.write_text('ok', encoding='utf-8')
            probe.unlink()
            return c
        except Exception:
            continue
    return None


def _resolve_model(model_name: str) -> Dict[str, str]:
    """返回 {arg, source, cache}: arg 可直接喂给 WhisperModel。"""
    p = _preinstalled_model_dir(model_name)
    if p:
        return {'arg': str(p), 'source': 'preinstalled', 'cache': str(p.parent)}
    cache = _pick_writable_dir([
        Path(os.environ['DOUYIN_HF_HOME']) if os.environ.get('DOUYIN_HF_HOME') else _DEPS_ROOT / 'models' / 'hf',
        _DEPS_ROOT / 'models' / 'hf',
        Path.cwd() / '.hf-cache',
        Path(tempfile.gettempdir()) / 'douyin-hf',
    ])
    if cache:
        os.environ.setdefault('HF_HOME', str(cache))
        os.environ['HF_HOME'] = str(cache)
    return {'arg': model_name, 'source': 'huggingface', 'cache': str(cache) if cache else '(默认)'}


def _setup_dll_paths() -> List[str]:
    """把 cuBLAS / cuDNN 目录挂上（多来源探测，不假设正好在 PATH 里）。"""
    dirs: List[str] = []
    if _DEPS_PY.is_dir():
        dirs.append(str(_DEPS_PY / 'ctranslate2'))
        dirs.extend(glob.glob(str(_DEPS_PY / 'nvidia' / '*' / 'bin')))
    for env_key in ('CUDA_PATH', 'CUDA_HOME'):
        v = os.environ.get(env_key)
        if v:
            dirs.append(os.path.join(v, 'bin'))
    dirs.extend(glob.glob(r'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v*\bin'))
    seen, out = set(), []
    for d in dirs:
        if d and os.path.isdir(d):
            k = os.path.normcase(os.path.realpath(d))
            if k not in seen:
                seen.add(k)
                out.append(d)
                try:
                    os.add_dll_directory(d)  # type: ignore[attr-defined]
                except Exception:
                    pass
                os.environ['PATH'] = d + os.pathsep + os.environ.get('PATH', '')
    return out


_DLL_DIRS = _setup_dll_paths()


# ============================================================================
# 3. 基础工具
# ============================================================================

def _ffmpeg_exe() -> str:
    return os.environ.get('FFMPEG_BIN_OVERRIDE') or 'ffmpeg'


def _ffprobe_exe() -> str:
    return os.environ.get('FFPROBE_BIN') or 'ffprobe'


def _probe_duration(video_path: str) -> float:
    """用 ffprobe 拿时长。沙箱可能禁止 Python 建管道，故重定向到临时文件。"""
    tmp = tempfile.NamedTemporaryFile(suffix='.txt', delete=False)
    tmp.close()
    try:
        with open(tmp.name, 'w', encoding='utf-8') as f:
            proc = subprocess.Popen(
                [_ffprobe_exe(), '-v', 'error', '-show_entries', 'format=duration',
                 '-of', 'default=nw=1:nk=1', str(video_path)],
                stdout=f, stderr=subprocess.DEVNULL)
            proc.wait(timeout=60)
        with open(tmp.name, encoding='utf-8') as f:
            return float(f.read().strip())
    except Exception:
        return 0.0
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def _make_session(timeout: tuple = (8, 60), retries: int = 2) -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    retry = Retry(total=retries, connect=retries, read=retries, backoff_factor=1.0,
                  status_forcelist=[429, 500, 502, 503, 504],
                  allowed_methods=frozenset(['GET', 'POST']), raise_on_status=False)
    adapter = HTTPAdapter(max_retries=retry, pool_connections=5, pool_maxsize=10)
    s.mount('http://', adapter)
    s.mount('https://', adapter)
    s.timeout = timeout
    return s


def _run_quiet(cmd: List[str], timeout: int) -> int:
    """跑子进程但不吃它的管道（沙箱友好）。返回退出码；-1 表示异常。"""
    try:
        return subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              timeout=timeout).returncode
    except Exception:
        return -1


# ============================================================================
# 4. 处理器
# ============================================================================

# ---------------------------------------------------------------------------
# 抽帧的辅助件：镜头切变检测 / 感知去重 / 帧与台词对齐
# ---------------------------------------------------------------------------

def _motion_profile(video_path: str, fps: float = 4.0, size: int = 16,
                    timeout: int = 600) -> List[Any]:
    """一次解码拿到全片的低分辨率灰度序列，用来算"画面变了多少"。

    做法：16x16 灰度、每秒 4 帧、rawvideo 直接出管道。114 秒的片子约 65 KB，
    一条命令跑完，比逐帧调 ffmpeg 快一个数量级。
    不用 ffmpeg 的 scene 滤镜：新版把这些参数挪走了，不同发行版行为不一致。
    """
    cmd = [_ffmpeg_exe(), '-v', 'error', '-i', str(video_path),
           '-vf', f'fps={fps},scale={size}:{size}:flags=area,format=gray',
           '-f', 'rawvideo', '-']
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except Exception:
        return []
    raw = proc.stdout or b''
    n = size * size
    if len(raw) < n * 2:
        return []
    frames = [raw[i * n:(i + 1) * n] for i in range(len(raw) // n)]
    return [(round(i / fps, 2), frames[i]) for i in range(len(frames))]


def _motion_cuts(profile: List[Any], min_gap: float = 0.35) -> List[Dict[str, Any]]:
    """从序列里挑出"画面突变"的时间点（疑似切镜头），返回 [{t, diff}]。"""
    if len(profile) < 3:
        return []
    diffs = [_hamming(profile[i][1], profile[i - 1][1]) for i in range(1, len(profile))]
    ordered = sorted(diffs)
    # 阈值取 80 分位，且不低于 8：静止画面里的小抖动不算切变
    p80 = ordered[int(len(ordered) * 0.8)] if ordered else 0
    threshold = max(8, p80)
    cuts: List[Dict[str, Any]] = []
    last_t = -99.0
    for i, d in enumerate(diffs):
        if d < threshold:
            continue
        t = profile[i + 1][0]
        if t - last_t < min_gap:
            # 同一拍里留差异更大的那个
            if cuts and d > cuts[-1]['diff']:
                cuts[-1] = {'t': t, 'diff': d}
                last_t = t
            continue
        cuts.append({'t': t, 'diff': d})
        last_t = t
    return cuts


def _frame_signature(video_path: str, t: float) -> Optional[bytes]:
    """取该时间点的 8x8 灰度缩略图（64 字节），用来判断两帧像不像。"""
    cmd = [_ffmpeg_exe(), '-v', 'error', '-ss', f'{t:.3f}', '-i', str(video_path),
           '-vf', 'scale=8:8,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-']
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=60)
    except Exception:
        return None
    return r.stdout if len(r.stdout) == 64 else None


def _hamming(a: bytes, b: bytes) -> int:
    """两帧灰度缩略图的差异位数，越小越像。"""
    return sum(bin(x ^ y).count('1') for x, y in zip(a, b))


def _is_blank(sig: Optional[bytes], min_variance: float = 90.0) -> bool:
    """几乎纯色的帧（淡入淡出、全黑、全白）判为空白，别浪费格子。"""
    if not sig:
        return False
    vals = list(sig)
    mean = sum(vals) / len(vals)
    var = sum((v - mean) ** 2 for v in vals) / len(vals)
    return var < min_variance


def _align_frames_to_text(manifest: List[Dict[str, Any]],
                          segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """把每一帧的时间点对到当时正在说的那句台词。"""
    out: List[Dict[str, Any]] = []
    for m in manifest:
        t = float(m.get('t_seconds', 0))
        line = ''
        if segments:
            hit = next((s for s in segments if s['start'] <= t <= s['end']), None)
            if hit is None:
                hit = min(segments, key=lambda s: abs(s['start'] - t))
            line = hit['text'] if hit else ''
        out.append({'tile': int(m.get('index', 0)) + 1, 't_seconds': t, 'line': line})
    return out


# ---------------------------------------------------------------------------
# 硬字幕 OCR（视觉线补强）
# ---------------------------------------------------------------------------
# 为什么不能靠视觉模型读字幕：把 N 帧拼成一张 contact_sheet 交给 VLM 时，
# 整图会被压到 ~60 万像素预算，单格字幕只剩 8~15px；实测把「诸葛亮也太啰嗦了」
# 读成「莽撞」、「陛下亦宜自谋」读成「务必自谋」——模型是在猜，不是在读。
# 硬字幕在原片 1080 宽下字高约 86px，直接对底部字幕带跑 OCR 才是正解：
# RapidOCR(PP-OCRv4 onnx) 实测单帧 1.15s、4/4 全中、置信度 0.95~1.0。
# OCR 是增强项：引擎装不上就安静跳过，绝不拖垮 ASR/抽帧主链路。
# ---------------------------------------------------------------------------

_OCR_SITE_CANDIDATES = [
    os.environ.get('RAPIDOCR_SITE', ''),
    # 2026-11-17：不再写死本机绝对路径 —— 跟着「依赖根目录」走（见 _default_deps_root）
    str(_DEPS_ROOT / 'py311-site'),
    str(Path(os.environ.get('DSH_DEPS', str(_DEPS_ROOT))) / 'py311-site'),
]


def _load_ocr_engine():
    """懒加载 RapidOCR。装不上返回 None（不抛异常）。"""
    for p in _OCR_SITE_CANDIDATES:
        if p and os.path.isdir(p) and p not in sys.path:
            sys.path.insert(0, p)
    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception:
        return None
    try:
        return RapidOCR()
    except Exception:
        return None


def _probe_size(video_path: str):
    """ffprobe 拿 (宽, 高)。失败返回 (0, 0)。"""
    tmp = tempfile.NamedTemporaryFile(suffix='.txt', delete=False)
    tmp.close()
    try:
        with open(tmp.name, 'w', encoding='utf-8') as f:
            proc = subprocess.Popen(
                [_ffprobe_exe(), '-v', 'error', '-select_streams', 'v:0',
                 '-show_entries', 'stream=width,height', '-of', 'csv=p=0',
                 str(video_path)],
                stdout=f, stderr=subprocess.DEVNULL)
            proc.wait(timeout=60)
        with open(tmp.name, encoding='utf-8') as f:
            raw = f.read().strip().splitlines()[0]
        w, h = [int(float(x)) for x in raw.split(',')[:2]]
        return w, h
    except Exception:
        return 0, 0
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def _norm_subtitle(s: str) -> str:
    """归一化：去空白、去 OCR 常见的边缘标点噪声，用于相邻帧比对。"""
    t = re.sub(r'\s+', '', str(s or ''))
    return t.strip('。，、！？…,.!?·—-|"')


def _same_subtitle(a: str, b: str) -> bool:
    """两帧字幕算不算「同一句」。OCR 会在同一句上抖一两个字，得容错。"""
    if a == b:
        return True
    if not a or not b:
        return False
    if a in b or b in a:
        return min(len(a), len(b)) >= max(2, int(max(len(a), len(b)) * 0.6))
    import difflib
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.85


def _subtitle_band_frames(video_path: str, fps: float = 2.0,
                          bottom_ratio: float = 0.22, max_width: int = 1080,
                          timeout: int = 900):
    """一次解码取出底部字幕带的低帧率序列 [(t, ndarray), ...]。

    只裁底部、只留 2fps：比逐帧起 ffmpeg 进程快一个数量级，也让 OCR 的工作量
    从「整张 1080x1920」降到「1080x~420」。原片分辨率更低时按原宽处理。
    """
    w, h = _probe_size(video_path)
    if not w or not h:
        return []
    roi_h = max(16, int(round(h * bottom_ratio / 2)) * 2)
    y0 = h - roi_h
    out_w = min(w, max_width)
    out_h = max(2, int(round(roi_h * out_w / w / 2)) * 2)
    vf = f'fps={fps},crop={w}:{roi_h}:0:{y0}'
    if out_w != w:
        vf += f',scale={out_w}:{out_h}'
    cmd = [_ffmpeg_exe(), '-v', 'error', '-i', str(video_path), '-vf', vf,
           '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-']
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except Exception:
        return []
    raw = proc.stdout or b''
    fsz = out_w * out_h * 3
    if len(raw) < fsz:
        return []
    try:
        import numpy as np
    except Exception:
        return []
    out = []
    for i in range(len(raw) // fsz):
        arr = np.frombuffer(raw[i * fsz:(i + 1) * fsz], dtype=np.uint8)
        out.append((round(i / fps, 2), arr.reshape(out_h, out_w, 3)))
    return out


def ocr_subtitles(video_path: str, duration: float = 0.0, fps: float = 2.0,
                  bottom_ratio: float = 0.22, min_conf: float = 0.55,
                  max_frames: int = 600, engine=None, quiet: bool = True,
                  skip_static: bool = True, static_ratio: float = 0.002):
    """对底部硬字幕带做 OCR，合并相邻重复，返回带时间轴的字幕段。

    返回 {ok, segments:[{start,end,text,conf}], frames_ocr, elapsed, error?}
    segments 是「一句字幕一行」，可以直接和 transcript.md 的 ASR 文本对照。

    skip_static: 字幕是白字黑边，两帧的「高亮像素掩码」几乎一致就说明屏幕上的
    字幕没换，直接沿用上一次结果、不调 OCR。实测 30s 视频 59 帧里只有 9~12 帧
    真正需要识别，耗时从 58s 降到 10s 量级。
    """
    eng = engine if engine is not None else _load_ocr_engine()
    if eng is None:
        return {'ok': False, 'error': 'RapidOCR 未安装（pip install rapidocr-onnxruntime）',
                'segments': [], 'frames_ocr': 0, 'elapsed': 0.0}
    t0 = time.time()
    frames = _subtitle_band_frames(video_path, fps=fps, bottom_ratio=bottom_ratio)
    if not frames:
        return {'ok': False, 'error': '没取到字幕带画面（ffmpeg 解码失败或视频无画面轨）',
                'segments': [], 'frames_ocr': 0, 'elapsed': round(time.time() - t0, 2)}
    if len(frames) > max_frames:
        step = len(frames) / float(max_frames)
        frames = [frames[min(len(frames) - 1, int(i * step))] for i in range(max_frames)]

    segs: List[Dict[str, Any]] = []
    done = 0
    reused = 0
    prev_mask = None
    for t, img in frames:
        # 字幕没换就跳过 OCR：白字掩码的差异像素占比极小 ≈ 屏幕上还是同一句
        if skip_static and prev_mask is not None and segs:
            try:
                mask = (img.mean(axis=2) > 200)
                changed = int((mask ^ prev_mask).sum())
                if changed / float(mask.size) < static_ratio:
                    segs[-1]['end'] = t
                    reused += 1
                    prev_mask = mask
                    continue
                prev_mask = mask
            except Exception:
                prev_mask = None
        elif skip_static:
            try:
                prev_mask = (img.mean(axis=2) > 200)
            except Exception:
                prev_mask = None
        try:
            res, _el = eng(img)
        except Exception:
            continue
        done += 1
        if not res:
            continue
        keep = [str(r[1]).strip() for r in res if len(r) > 2 and float(r[2]) >= min_conf]
        text = _norm_subtitle(''.join(keep))
        if not text:
            continue
        conf = max(float(r[2]) for r in res if len(r) > 2)
        # 同一句连续出现几十帧很正常：延长上一条，别堆成几十行
        if segs and _same_subtitle(segs[-1]['text'], text):
            segs[-1]['end'] = t
            if len(text) > len(segs[-1]['text']) and conf >= segs[-1]['conf']:
                segs[-1]['text'] = text          # 取更完整的那次识别
            segs[-1]['conf'] = max(segs[-1]['conf'], conf)
            continue
        segs.append({'start': t, 'end': t, 'text': text, 'conf': round(conf, 3)})

    elapsed = round(time.time() - t0, 2)
    if segs:
        # 末段按 1/fps 补个尾巴，避免出现 start==end 的零宽度
        segs[-1]['end'] = max(segs[-1]['end'], segs[-1]['start'] + 1.0 / max(fps, 0.1))
    if not quiet:
        print(f'[OCR] 字幕带 {len(frames)} 帧 → 实跑 {done} 帧（复用 {reused} 帧）'
              f'→ {len(segs)} 段，用时 {elapsed}s', flush=True)
    return {'ok': True, 'segments': segs, 'frames_ocr': done,
            'frames_total': len(frames), 'frames_reused': reused,
            'elapsed': elapsed,
            'duration_s': round(duration, 2) if duration else 0.0}


def _write_subtitle_ocr(base: Path, ocr: Dict[str, Any]) -> Optional[Path]:
    """把 OCR 字幕段落成 subtitle_ocr.md，和 ASR 的 transcript.md 并列放。"""
    if not ocr or not ocr.get('ok'):
        return None
    p = Path(base) / 'subtitle_ocr.md'
    segs = ocr.get('segments') or []
    with open(p, 'w', encoding='utf-8') as f:
        f.write('# 画面硬字幕 OCR\n\n')
        f.write('| 属性 | 值 |\n|---|---|\n')
        f.write(f"| 引擎 | RapidOCR (PP-OCRv4 onnx, CPU) |\n")
        f.write(f"| OCR 帧数 | {ocr.get('frames_ocr')} / {ocr.get('frames_total')} |\n")
        f.write(f"| 字幕段 | {len(segs)} |\n")
        f.write(f"| 耗时 | {ocr.get('elapsed')}s |\n\n---\n\n")
        f.write('> 这是**画面上的硬字幕**，不是语音转写。与 `transcript.md` 的 ASR 文本'
                '互为校验：ASR 听错口语/方言时，以这里为准；'
                '画面没字幕时以 ASR 为准。\n\n')
        if not segs:
            f.write('（没识别到字幕，可能是无字幕视频或字幕不在底部 22% 区域）\n')
        else:
            f.write('| 时间 | 字幕 | 置信度 |\n|---|---|---|\n')
            for s in segs:
                txt = str(s['text']).replace('|', '／')
                f.write(f"| {s['start']:.1f}s ~ {s['end']:.1f}s | {txt} | {s['conf']} |\n")
    return p


class DouyinProcessor:
    def __init__(self, model_name: str = _DEFAULT_MODEL, device: str = 'auto',
                 asr_engine: str = 'cn'):
        self.model_name = model_name
        self.device = device
        self.asr_engine = (asr_engine or 'cn').lower()   # cn（默认，唯一引擎）| whisper（排障逃生口）
        self.asr_engine_used: Optional[str] = None
        self.temp_dir = Path(tempfile.mkdtemp(prefix='douyin-'))
        self._whisper_model = None
        self.session = _make_session()
        self.last_detected_language: Optional[str] = None
        self.last_segments: List[Dict[str, Any]] = []   # ASR 分段时间轴，供帧↔台词对齐用
        self.device_used: Optional[str] = None
        self.model_source: Optional[str] = None
        self.download_method: Optional[str] = None

    # ---------- ASR ----------
    @property
    def whisper_model(self):
        if self._whisper_model is None:
            from faster_whisper import WhisperModel
            info = _resolve_model(self.model_name)
            self.model_source = f"{info['source']}:{info['arg']}"
            attempts = []
            if self.device in ('auto', 'cuda'):
                attempts.append(('cuda', 'int8_float16'))
            if self.device in ('auto', 'cpu'):
                attempts.append(('cpu', 'int8'))
            last_err = None
            for dev, ct in attempts:
                try:
                    self._whisper_model = WhisperModel(info['arg'], device=dev, compute_type=ct)
                    self.device_used = dev
                    break
                except Exception as e:  # noqa: BLE001
                    last_err = e
            if self._whisper_model is None:
                raise RuntimeError(f'whisper 模型加载失败: {last_err}')
        return self._whisper_model

    # ---------- ASR：中文引擎（Paraformer，纯 CPU）----------
    @staticmethod
    def _cn_texts(res) -> List[str]:
        """funasr_onnx 的返回是 [{'preds': (文本, [逐字...])}]，只取文本那一半。"""
        out: List[str] = []

        def walk(x):
            if isinstance(x, str):
                out.append(x)
            elif isinstance(x, dict):
                if 'preds' in x:
                    walk(x['preds'])
                elif 'text' in x:
                    walk(x['text'])
            elif isinstance(x, (list, tuple)):
                if len(x) == 2 and isinstance(x[0], str) and isinstance(x[1], list):
                    walk(x[0])
                else:
                    for i in x:
                        walk(i)

        walk(res)
        return out

    def _transcribe_cn(self, audio_path: Path, show_progress: bool = True) -> str:
        """中文引擎：30 秒分片 → Paraformer 逐片识别 → CT-Transformer 加标点。

        为什么要切片：整段塞进去，40 分钟的片子会直接返回空（或 ONNX 报错）。
        30 秒是实测最稳的长度，切片边界同时当分段时间轴给帧↔台词对齐用。
        """
        import wave as _wave
        cn_dir = _cn_asr_ready()
        if not cn_dir:
            raise RuntimeError('没找到 funasr-onnx')
        if cn_dir not in sys.path:
            sys.path.insert(0, cn_dir)
        from funasr_onnx import Paraformer, CT_Transformer

        chunk_dir = self.temp_dir / 'cn_chunks'
        chunk_dir.mkdir(parents=True, exist_ok=True)
        paths: List[str] = []
        bounds: List[tuple] = []
        with _wave.open(str(audio_path), 'rb') as w:
            sr, nch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
            step = int(_CN_CHUNK_SEC * sr)
            idx = 0
            while True:
                raw = w.readframes(step)
                if not raw:
                    break
                p = chunk_dir / f'c_{idx:04d}.wav'
                with _wave.open(str(p), 'wb') as o:
                    o.setnchannels(nch)
                    o.setsampwidth(sw)
                    o.setframerate(sr)
                    o.writeframes(raw)
                paths.append(str(p))
                frames = len(raw) // max(1, nch * sw)
                bounds.append((idx * _CN_CHUNK_SEC, idx * _CN_CHUNK_SEC + frames / float(sr or 1)))
                idx += 1
        if not paths:
            return ''
        if show_progress:
            print(f'正在语音识别（中文引擎 paraformer，{len(paths)} 段 × {_CN_CHUNK_SEC:g}s）…')
        asr = Paraformer(model_dir=_CN_PARA, batch_size=4, quantize=True,
                         cache_dir=_CN_MODEL_CACHE, intra_op_num_threads=4)
        texts = self._cn_texts(asr(paths))
        punc = CT_Transformer(model_dir=_CN_PUNC, batch_size=1, quantize=True,
                              cache_dir=_CN_MODEL_CACHE, intra_op_num_threads=4)
        seg_list: List[Dict[str, Any]] = []
        for i, t in enumerate(texts):
            t = (t or '').strip()
            if not t:
                continue
            try:
                fixed = self._cn_texts(punc(t))
                if fixed and fixed[0].strip():
                    t = fixed[0].strip()
            except Exception:  # noqa: BLE001 —— 标点挂了不该毁掉整条转写
                pass
            s, e = bounds[i] if i < len(bounds) else (0.0, 0.0)
            # 按标点把这一段切成句子，时间按字数比例摊开 —— 否则对齐表粗到 30 秒一行
            parts = [x for x in re.split(r'(?<=[。！？!?；;])', t) if x and x.strip()]
            if not parts:
                parts = [t]
            total = sum(len(x) for x in parts) or 1
            cursor = float(s)
            span = max(0.0, float(e) - float(s))
            for part in parts:
                frac = len(part) / total
                seg_len = span * frac
                seg_list.append({'start': round(cursor, 2),
                                 'end': round(cursor + seg_len, 2),
                                 'text': part.strip()})
                cursor += seg_len
        self.last_segments = seg_list
        return ''.join(x['text'] for x in seg_list).strip()

    # ---------- ASR：分发 ----------
    def transcribe_audio(self, audio_path: Path, language: Optional[str] = None,
                         show_progress: bool = True) -> str:
        engine = (self.asr_engine or 'cn').lower()
        # 只有一套引擎：默认中文引擎。--asr whisper 是给排障留的逃生口，不参与默认链路，
        # 也不要求用户同时装两套（两套加起来 1 GB，不能这么干）。
        if engine == 'whisper':
            txt = self._transcribe_whisper(audio_path, language, show_progress)
            self.asr_engine_used = 'whisper'
            return txt

        cn_dir = _ensure_cn_deps(show_progress=show_progress)
        if not cn_dir:
            raise RuntimeError(
                '中文转写引擎不可用：没找到 funasr-onnx，自动安装也失败了。\n'
                f'  手动装：pip install --target "{_CN_ASR_DIR}" funasr-onnx modelscope\n'
                '  或设 DOUYIN_CN_ASR_DIR 指到已装好的目录。')
        txt = self._transcribe_cn(audio_path, show_progress=show_progress)
        self.asr_engine_used = 'paraformer-cn'
        self.device_used = 'cpu'
        self.model_source = f'modelscope:{_CN_PARA}'
        if not self.last_detected_language:
            self.last_detected_language = 'zh'
        return txt

    def _transcribe_whisper(self, audio_path: Path, language: Optional[str] = None,
                            show_progress: bool = True) -> str:
        if show_progress:
            print(f'正在语音识别（{self.model_name}，{self.device_used or self.device}）…')
        try:
            return self._transcribe_once(audio_path, language)
        except Exception as e:  # CUDA/cuBLAS 常在推理时才炸 → 降级 CPU 重试一次
            if self.device_used == 'cuda':
                if show_progress:
                    print(f'GPU 推理失败（{e}），改用 CPU 重试…')
                from faster_whisper import WhisperModel
                info = _resolve_model(self.model_name)
                self._whisper_model = WhisperModel(info['arg'], device='cpu', compute_type='int8')
                self.device_used = 'cpu'
                return self._transcribe_once(audio_path, language)
            raise

    def _transcribe_once(self, audio_path: Path, language: Optional[str]) -> str:
        segments, info = self.whisper_model.transcribe(
            str(audio_path), beam_size=5, language=language, vad_filter=True)
        self.last_detected_language = info.language
        # 顺手把分段时间轴收下来：抽帧对齐台词靠它，不额外花钱
        seg_list: List[Dict[str, Any]] = []
        pieces: List[str] = []
        for seg in segments:
            txt = (seg.text or '').strip()
            if txt:
                pieces.append(seg.text)
                seg_list.append({'start': round(float(seg.start), 2),
                                 'end': round(float(seg.end), 2),
                                 'text': txt})
        self.last_segments = seg_list
        return ''.join(pieces).strip()

    # ---------- 取流 ----------
    def _resolve_share_url(self, share_text: str) -> str:
        urls = URL_RE.findall(share_text)
        if not urls:
            raise ResolveError('未找到有效的分享链接', hint='把完整的抖音分享文本或链接传进来。')
        return urls[0]

    def _video_id(self, share_url: str) -> str:
        r = self.session.get(share_url, headers=MOBILE_HEADERS, timeout=(10, 45),
                             allow_redirects=True)
        r.raise_for_status()
        vid = r.url.split('?')[0].strip('/').split('/')[-1]
        if not re.fullmatch(r'\d+', vid):
            raise ResolveError(f'短链未重定向到视频页：{r.url[:120]}')
        return vid

    def _parse_via_router_data(self, share_url: str) -> Dict[str, Any]:
        vid = self._video_id(share_url)
        page = self.session.get(f'https://www.iesdouyin.com/share/video/{vid}',
                                headers=MOBILE_HEADERS, timeout=(10, 45))
        page.raise_for_status()
        m = re.search(r'window\._ROUTER_DATA\s*=\s*(.*?)</script>', page.text, re.DOTALL)
        if not m:
            raise ResolveError('分享页结构已变（找不到 _ROUTER_DATA）')
        data = json.loads(m.group(1).strip())
        ld = data.get('loaderData', {})
        info = None
        for k in ('video_(id)/page', 'note_(id)/page'):
            if k in ld and isinstance(ld[k], dict) and ld[k].get('videoInfoRes'):
                info = ld[k]['videoInfoRes']
                break
        if not info:
            raise ResolveError('分享页命中风控/验证（videoInfoRes 为空）')
        item = info['item_list'][0]
        urls = item.get('video', {}).get('play_addr', {}).get('url_list', [])
        if not urls:
            raise ResolveError('play_addr.url_list 为空')
        title = (item.get('desc') or f'douyin_{vid}').strip()
        return {
            'video_id': vid,
            'title': re.sub(r'[\\/:*?"<>|]', '_', title),
            'url': urls[0].replace('playwm', 'play'),
            'audio_url': None,
            'source': 'router_data',
        }

    def _parse_via_ytdlp(self, share_url: str, cookies: Optional[str] = None,
                         cookies_from_browser: Optional[str] = None) -> Dict[str, Any]:
        import yt_dlp

        class _Quiet:
            """yt-dlp 默认往 stderr 打 ERROR 噪音，这里全部吞掉（异常里仍带原文）。"""

            def debug(self, msg): pass
            def info(self, msg): pass
            def warning(self, msg): pass
            def error(self, msg): pass

        opts: Dict[str, Any] = {'quiet': True, 'no_warnings': True, 'skip_download': True,
                                'noplaylist': True, 'socket_timeout': 25, 'retries': 1,
                                'no_color': True, 'logger': _Quiet()}
        if cookies:
            opts['cookiefile'] = cookies
        if cookies_from_browser:
            opts['cookiesfrombrowser'] = tuple(cookies_from_browser.split(':', 1))
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(share_url, download=False)
        vid = str(info.get('id') or '')
        if not vid:
            raise ResolveError('yt-dlp 未解析出视频 ID')
        url = None
        for f in sorted((info.get('formats') or []),
                        key=lambda f: (f.get('height') or 0, f.get('tbr') or 0), reverse=True):
            if f.get('url'):
                url = f['url']
                break
        url = url or info.get('url')
        if not url:
            raise ResolveError('yt-dlp 未解析出下载地址')
        title = (info.get('title') or f'douyin_{vid}').strip()
        return {'video_id': vid, 'title': re.sub(r'[\\/:\*?"<>|]', '_', title),
                'url': url, 'audio_url': None, 'source': 'yt_dlp'}

    def _parse_via_browser(self, share_url: str, timeout: int = 45,
                           profile: Optional[str] = None, fresh_profile: bool = False,
                           headed: bool = False) -> Dict[str, Any]:
        if not _BROWSER_HELPER.exists():
            raise ResolveError(f'缺少浏览器抓链脚本：{_BROWSER_HELPER}')
        node = os.environ.get('DOUYIN_NODE') or shutil.which('node')
        if not node:
            raise ResolveError('未找到 node，无法使用浏览器取流（可设 DOUYIN_NODE）')
        # 先把真实视频 ID 解析出来（短链 → 数字 ID），浏览器里只认 www.douyin.com/video/<id>
        vid = None
        try:
            vid = self._video_id(share_url)
        except Exception:  # noqa: BLE001
            m = re.search(r'/video/(\d+)', share_url)
            vid = m.group(1) if m else None
        page_url = f'https://www.douyin.com/video/{vid}' if vid else share_url
        out_json = Path(tempfile.mkdtemp(prefix='douyin-br-')) / 'media.json'
        cmd = [node, str(_BROWSER_HELPER), '--url', page_url, '--out', str(out_json),
               '--timeout', str(timeout)]
        if profile:
            cmd += ['--profile', profile]
        if fresh_profile:
            cmd.append('--fresh-profile')
        if headed:
            cmd.append('--headed')
        _run_quiet(cmd, timeout=timeout + 90)
        if not out_json.exists():
            raise ResolveError(f'浏览器取流未产出结果（{timeout}s 内未拿到播放器直链）')
        data = json.loads(out_json.read_text(encoding='utf-8'))
        shutil.rmtree(out_json.parent, ignore_errors=True)
        if not data.get('ok'):
            reason = data.get('error') or ('页面命中验证码' if data.get('captcha') else '未拿到媒体直链')
            raise ResolveError(f'浏览器取流失败：{reason}')
        title = (data.get('title') or data.get('desc') or '').strip()
        title = re.sub(r'\s*-\s*抖音\s*$', '', title)
        m = re.search(r'/video/(\d+)', share_url) or re.search(r'(\d{15,})', str(data.get('video_src') or ''))
        return {
            'video_id': (m.group(1) if m else str(abs(hash(title)) % 10 ** 18)),
            'title': re.sub(r'[\\/:*?"<>|]', '_', title or 'douyin_video'),
            'url': data['video_url'],
            'audio_url': data.get('audio_url'),
            'duration_hint': data.get('duration'),
            'source': 'browser',
        }

    def resolve(self, share_text: str, *, media_url: Optional[str] = None,
                audio_url: Optional[str] = None, video_id: Optional[str] = None,
                title: Optional[str] = None, cookies: Optional[str] = None,
                cookies_from_browser: Optional[str] = None,
                use_browser: Optional[bool] = None, browser_timeout: int = 45,
                browser_profile: Optional[str] = None, fresh_profile: bool = False,
                headed: bool = False, quiet: bool = False) -> Dict[str, Any]:
        """按策略链取流；每一级都有超时，全失败则抛出带建议的 ResolveError。"""
        if media_url:
            return {'video_id': video_id or 'local_url', 'title': title or 'direct_url',
                    'url': media_url, 'audio_url': audio_url, 'source': 'explicit_url'}
        if not share_text:
            raise ResolveError('既没有分享链接，也没有 --url/--video', hint=COOKIE_HINT)

        share_url = self._resolve_share_url(share_text)
        errors: List[str] = []

        for name, fn in (
            ('router_data', lambda: self._parse_via_router_data(share_url)),
            ('yt_dlp', lambda: self._parse_via_ytdlp(share_url)),
        ):
            try:
                info = fn()
                self.download_method = name
                return info
            except Exception as e:  # noqa: BLE001
                errors.append(f'{name}: {e}')
                if not quiet:
                    print(f'  [取流] {name} 不可用（{str(e)[:80]}）')

        if cookies or cookies_from_browser:
            try:
                info = self._parse_via_ytdlp(share_url, cookies=cookies,
                                             cookies_from_browser=cookies_from_browser)
                self.download_method = 'yt_dlp+cookies'
                return info
            except Exception as e:  # noqa: BLE001
                errors.append(f'yt_dlp+cookies: {e}')

        if use_browser is not False:
            try:
                info = self._parse_via_browser(share_url, timeout=browser_timeout,
                                               profile=browser_profile,
                                               fresh_profile=fresh_profile, headed=headed)
                self.download_method = 'browser'
                return info
            except Exception as e:  # noqa: BLE001
                errors.append(f'browser: {e}')

        detail = '\n  '.join(errors)
        raise ResolveError(f'全部取流策略失败：\n  {detail}', hint=COOKIE_HINT)

    # ---------- 下载 ----------
    def _download_one(self, url: str, dest: Path, referer: str = _REFERER,
                      progress: bool = False) -> Path:
        with self.session.get(url, headers={**HEADERS, 'Referer': referer},
                              stream=True, timeout=(10, 120)) as r:
            r.raise_for_status()
            ctype = (r.headers.get('content-type') or '').lower()
            if ctype and not ctype.startswith(_VIDEO_CT_PREFIXES):
                raise ResolveError(f'下载被拦截：服务器返回 {ctype}（疑似验证码/错误页）')
            total = int(r.headers.get('content-length') or 0)
            got = 0
            with open(dest, 'wb') as f:
                for chunk in r.iter_content(8192):
                    if chunk:
                        f.write(chunk)
                        got += len(chunk)
            if got == 0:
                raise ResolveError('下载到 0 字节')
        if progress:
            print(f'  已下载 {dest.name} ({got/1024/1024:.2f} MB)')
        return dest

    def download_video(self, video_info: Dict[str, Any], output_dir: Optional[Path] = None,
                       show_progress: bool = True, retries: int = 2) -> Path:
        out = Path(output_dir) if output_dir else self.temp_dir
        out.mkdir(parents=True, exist_ok=True)
        stem = str(video_info['video_id'])
        target = out / f'{stem}.mp4'
        last_err: Optional[Exception] = None

        for attempt in range(retries + 1):
            try:
                if video_info.get('audio_url'):
                    vtmp = out / f'{stem}.video.mp4'
                    atmp = out / f'{stem}.audio.mp4'
                    if show_progress:
                        print('正在下载视频/音频轨…')
                    self._download_one(video_info['url'], vtmp, progress=show_progress)
                    self._download_one(video_info['audio_url'], atmp, progress=show_progress)
                    rc = _run_quiet([_ffmpeg_exe(), '-y', '-i', str(vtmp), '-i', str(atmp),
                                     '-c', 'copy', str(target)], timeout=180)
                    for f in (vtmp, atmp):
                        try:
                            f.unlink()
                        except OSError:
                            pass
                    if rc != 0 or not target.exists():
                        # 合轨失败就退回只有画面的文件，至少别让整条流水线死掉
                        self._download_one(video_info['url'], target, progress=False)
                    if show_progress:
                        print(f'下载完成：{target} ({target.stat().st_size/1024/1024:.2f} MB)')
                else:
                    if show_progress:
                        print('正在下载视频…')
                    self._download_one(video_info['url'], target, progress=show_progress)
                return target
            except Exception as e:  # noqa: BLE001
                last_err = e
                if attempt < retries:
                    time.sleep(2 * (attempt + 1))
                else:
                    for f in (target, out / f'{stem}.video.mp4', out / f'{stem}.audio.mp4'):
                        try:
                            f.unlink()
                        except OSError:
                            pass
                    raise ResolveError(f'下载失败（已重试 {retries} 次）：{last_err}')
        raise ResolveError(f'下载失败：{last_err}')

    # ---------- 音频 / 视觉 ----------
    def extract_audio(self, video_path: Path, show_progress: bool = True) -> Path:
        audio_path = Path(video_path).with_suffix('.wav')
        rc = _run_quiet([_ffmpeg_exe(), '-y', '-i', str(video_path), '-acodec', 'pcm_s16le',
                         '-ar', '16000', '-ac', '1', str(audio_path)], timeout=600)
        if rc != 0 or not audio_path.exists():
            raise RuntimeError(f'提取音频失败（ffmpeg rc={rc}）')
        return audio_path

    def extract_frames(self, video_path: Path, output_dir: Path, interval: Optional[int] = None,
                       max_width: int = 720, max_frames: int = 30,
                       use_scene: bool = True, dedupe: bool = True,
                       dedupe_tolerance: int = 2) -> List[Path]:
        """抽帧：按镜头切变为主、均匀采样兜底，再去掉几乎一样的帧。

        为什么不再纯按秒抽：30 秒 30fps 的视频共 900 帧，按秒抽只取 10 帧，
        遇到"一秒切四刀"的快剪段会整整漏掉两个镜头。场景检测能保证每个镜头
        至少留一帧；静止段靠相似去重只留一张，省下的预算回到有变化的段落。
        文件名仍用连续序号（f_000.jpg…），方便 ffmpeg 拼 contact sheet。
        """
        duration = _probe_duration(str(video_path)) or 0.0
        if interval is None:
            interval = 1 if duration and duration < 10 else 3

        # 候选一：画面突变点（切镜头、翻页、大动作都在这里）
        cuts: List[Dict[str, Any]] = []
        if use_scene:
            profile = _motion_profile(str(video_path))
            cuts = _motion_cuts(profile)
        cuts_set = {round(c['t'], 2) for c in cuts}

        # 候选二：均匀采样（兜底，防止大段静止画面一帧都没有）
        if duration:
            step = max(1, int(interval))
            uniform = [float(t) for t in range(0, max(1, int(math.ceil(duration))), step)] or [0.0]
        else:
            uniform = [float(i * 3) for i in range(max_frames)]

        candidates = sorted(set(list(cuts_set) + [round(u, 2) for u in uniform]))

        # 相距不到 0.4 秒的算同一拍，同一拍里优先保留切变点
        thinned: List[float] = []
        for t in candidates:
            if not thinned or (t - thinned[-1]) >= 0.4:
                thinned.append(t)
            elif t in cuts_set:
                thinned[-1] = t

        # 预算控制：超了就在时间轴上等距取舍，保证覆盖全片而不是只顾前段
        if max_frames and len(thinned) > max_frames:
            if max_frames == 1:
                thinned = [thinned[0]]
            else:
                idx = [round(i * (len(thinned) - 1) / (max_frames - 1)) for i in range(max_frames)]
                thinned = [thinned[i] for i in sorted(set(idx))]

        output_dir.mkdir(parents=True, exist_ok=True)
        frames: List[Path] = []
        manifest: List[Dict[str, Any]] = []
        last_sig: Optional[bytes] = None

        for t in thinned:
            fp = output_dir / f'f_{len(frames):03d}.jpg'
            rc = _run_quiet([_ffmpeg_exe(), '-y', '-ss', f'{t:.3f}', '-i', str(video_path),
                             '-vf', f'scale={max_width}:-1', '-frames:v', '1', str(fp)],
                            timeout=120)
            if rc != 0 or not fp.exists():
                continue
            if dedupe:
                sig = _frame_signature(str(video_path), t)
                # 空白帧（淡入淡出、全黑）不占格子
                if _is_blank(sig):
                    try:
                        fp.unlink()
                    except OSError:
                        pass
                    continue
                if sig and last_sig is not None and _hamming(sig, last_sig) <= dedupe_tolerance:
                    try:
                        fp.unlink()
                    except OSError:
                        pass
                    continue
                last_sig = sig
            frames.append(fp)
            manifest.append({'index': len(frames) - 1, 't_seconds': round(t, 2),
                             'file': fp.name, 'scene_cut': round(t, 2) in cuts_set})

        (output_dir / 'manifest.json').write_text(
            json.dumps({
                'duration_s': round(duration, 2),
                'interval_s': interval,
                'sampling': 'scene+uniform' if use_scene else 'uniform',
                'motion_cuts': len(cuts_set),
                'frames': manifest,
            }, ensure_ascii=False, indent=1), encoding='utf-8')
        return frames

    def make_contact_sheet(self, frames_dir: Path, out_path: Path, cols: int = 3,
                           tile_width: int = 720) -> Optional[Path]:
        """把整段帧图拼成一张联系表（contact sheet）。

        目的：让"看画面"从 N 次视觉调用变成 1 次，token 消耗降一个数量级。
        """
        frames = sorted(Path(frames_dir).glob('f_*.jpg'))
        if not frames:
            return None
        rows = max(1, math.ceil(len(frames) / cols))
        out_path.parent.mkdir(parents=True, exist_ok=True)
        vf = (f'scale={tile_width}:-1,tile={cols}x{rows}:padding=4:margin=4')
        rc = _run_quiet([_ffmpeg_exe(), '-y', '-framerate', '1', '-i',
                         str(Path(frames_dir) / 'f_%03d.jpg'), '-vf', vf,
                         '-frames:v', '1', '-q:v', '4', str(out_path)], timeout=180)
        if rc != 0 or not out_path.exists():
            # 兜底：单帧拼不动就只保留首帧，宁可少给也别失败
            try:
                shutil.copy2(frames[0], out_path)
                return out_path
            except Exception:
                return None
        return out_path

    def cleanup_files(self, *paths: Path) -> None:
        for p in paths:
            try:
                if p and Path(p).exists():
                    Path(p).unlink()
            except OSError:
                pass

    def __del__(self):
        try:
            if getattr(self, 'temp_dir', None) and Path(self.temp_dir).exists():
                shutil.rmtree(self.temp_dir, ignore_errors=True)
            if getattr(self, 'session', None):
                self.session.close()
        except Exception:
            pass


# ============================================================================
# 5. 对外 API
# ============================================================================

def get_video_info(share_link: str, **kw) -> Dict[str, Any]:
    p = DouyinProcessor(model_name=kw.pop('model_name', _DEFAULT_MODEL))
    return p.resolve(share_link, **kw)


def download_video(share_link: str, output_dir: str = '.', **kw) -> Path:
    p = DouyinProcessor(model_name=kw.pop('model_name', _DEFAULT_MODEL))
    info = p.resolve(share_link, **kw)
    return p.download_video(info, Path(output_dir))


def _acquire(p: DouyinProcessor, share_link: Optional[str], video_path: Optional[str],
             quiet: bool, **kw) -> Dict[str, Any]:
    """拿到本地视频文件：本地文件优先，其次取流后下载。"""
    if video_path:
        vp = Path(video_path)
        if not vp.exists():
            raise ResolveError(f'本地视频不存在：{vp}', hint='检查 --video 路径。')
        return {'info': {'video_id': vp.stem, 'title': vp.stem, 'url': None,
                         'audio_url': None, 'source': 'local_file'},
                'path': vp, 'method': 'local_file'}
    info = p.resolve(share_link, quiet=quiet, **kw)
    vp = p.download_video(info, show_progress=not quiet)
    return {'info': info, 'path': vp, 'method': p.download_method or info.get('source') or '?'}


def analyze(share_link: Optional[str] = None, frames_dir: Optional[str] = None,
            model_name: str = _DEFAULT_MODEL, interval: Optional[int] = None,
            max_frames: int = 15, *, video_path: Optional[str] = None,
            device: str = 'auto', quiet: bool = True, out_dir: Optional[str] = None,
            persist: bool = True, keep_frames: bool = False, keep_video: bool = False,
            cols: int = 3, list_frames: bool = False, subtitle_ocr: bool = False,
            ocr_fps: float = 2.0, ocr_bottom_ratio: float = 0.22,
            asr: str = 'cn', **kw) -> Dict[str, Any]:
    """双线分析：拿到视频 → ASR 转录 + 抽帧 → 合成一张联系表。

    省 token 的关键设计：
      * 返回值**不含**逐帧路径列表（要的话加 list_frames=True），只有一张 contact_sheet
      * 默认把 transcript.md / contact_sheet.jpg 落到 <cwd>/douyin_out/<video_id>/，
        重复提问不必重跑 ASR；--no-persist 可关掉
      * 抽帧的中间文件拼完联系表即删（keep_frames=True 可留）

    kw 透传给 resolve()：media_url/audio_url/cookies/cookies_from_browser/
    use_browser/browser_timeout/browser_profile/fresh_profile/headed …
    """
    p = DouyinProcessor(model_name=model_name, device=device, asr_engine=asr)
    got = _acquire(p, share_link, video_path, quiet, **kw)
    vp, info = got['path'], got['info']
    video_id = str(info.get('video_id') or 'video')
    title = str(info.get('title') or video_id)

    base: Optional[Path]
    if out_dir:
        # 支持 {video_id} 模板：调用方无需先解析 ID
        base = Path(str(out_dir).replace('{video_id}', video_id))
    elif persist:
        base = Path.cwd() / 'douyin_out' / video_id
    else:
        base = None
    scratch = Path(frames_dir) if frames_dir else Path(tempfile.mkdtemp(prefix='douyin-frames-'))
    own_scratch = frames_dir is None

    audio = p.extract_audio(vp, show_progress=not quiet)
    text = p.transcribe_audio(audio, show_progress=not quiet)
    p.cleanup_files(audio)
    frames = p.extract_frames(vp, scratch, interval=interval, max_frames=max_frames)
    duration = _probe_duration(str(vp))

    sheet_dir = base if base else scratch
    sheet_dir.mkdir(parents=True, exist_ok=True)
    sheet = p.make_contact_sheet(scratch, sheet_dir / 'contact_sheet.jpg', cols=cols)

    transcript_path = None
    if base:
        transcript_path = base / 'transcript.md'
        with open(transcript_path, 'w', encoding='utf-8') as f:
            f.write(f"# {title}\n\n| 属性 | 值 |\n|---|---|\n")
            f.write(f"| 视频ID | `{video_id}` |\n| 取流方式 | {got['method']} |\n")
            f.write(f"| ASR | faster-whisper {model_name} @ {p.device_used} |\n")
            f.write(f"| 模型来源 | {p.model_source} |\n| 检测语言 | {p.last_detected_language} |\n")
            f.write(f"| 时长 | {round(duration, 2)}s | 帧数 | {len(frames)} |\n\n---\n\n")
            f.write(f'## 文案内容\n\n{text}\n')
            # 帧 ↔ 台词对齐表：让"看画面"这件事带上时间轴，而不是一堆孤立图
            try:
                mf = json.loads((scratch / 'manifest.json').read_text(encoding='utf-8'))
                aligned = _align_frames_to_text(mf.get('frames') or [], p.last_segments or [])
                if aligned:
                    rows = max(1, math.ceil(len(aligned) / max(1, cols)))
                    f.write('\n## 画面 ↔ 台词对齐\n\n')
                    f.write(f'联系表 `contact_sheet.jpg` 是 {cols} 列 × {rows} 行，'
                            f'第 1 格在左上角，从左到右、从上到下依次是下面这些：\n\n')
                    f.write('| 格 | 时间点 | 当时在说 |\n|---|---|---|\n')
                    for a in aligned:
                        line = (a['line'] or '（无台词）').replace('|', '／')
                        f.write(f"| {a['tile']} | {a['t_seconds']:.1f}s | {line} |\n")
                    f.write('\n> 读画面时优先看相邻两格之间的变化；'
                            '切变帧已单独标出，静止片段已去重。\n')
            except Exception:
                pass
            # 抽样元数据也留一份在输出目录，方便回头查每帧是怎么选的
            try:
                if scratch != base:
                    shutil.copy2(scratch / 'manifest.json', base / 'manifest.json')
            except Exception:
                pass

    # --- 硬字幕 OCR：必须赶在视频被清理之前跑 ---
    ocr_info: Dict[str, Any] = {}
    ocr_md: Optional[Path] = None
    if subtitle_ocr:
        try:
            ocr_res = ocr_subtitles(vp, duration=duration, fps=ocr_fps,
                                    bottom_ratio=ocr_bottom_ratio, quiet=quiet)
            ocr_info = {'ok': bool(ocr_res.get('ok')),
                        'segment_count': len(ocr_res.get('segments') or []),
                        'frames_ocr': ocr_res.get('frames_ocr'),
                        'frames_total': ocr_res.get('frames_total'),
                        'elapsed': ocr_res.get('elapsed')}
            if ocr_res.get('error'):
                ocr_info['error'] = ocr_res['error']
            if ocr_res.get('ok') and base:
                ocr_md = _write_subtitle_ocr(base, ocr_res)
                ocr_info['path'] = str(ocr_md) if ocr_md else None
            elif ocr_res.get('ok'):
                # 没开 persist 就退而把段落塞进返回值，别让 OCR 白跑
                ocr_info['segments'] = ocr_res.get('segments') or []
        except Exception as exc:
            ocr_info = {'ok': False, 'error': f'{type(exc).__name__}: {exc}',
                        'segment_count': 0}

    if own_scratch and not keep_frames:
        shutil.rmtree(scratch, ignore_errors=True)
    if video_path is None and not keep_video:
        p.cleanup_files(vp)

    result: Dict[str, Any] = {
        'video_id': video_id,
        'title': title,
        'text': text,
        'text_chars': len(text),
        'language': p.last_detected_language,
        'duration_s': round(duration, 2),
        'frame_count': len(frames),
        'contact_sheet': str(sheet) if sheet else None,
        'transcript': str(transcript_path) if transcript_path else None,
        'out_dir': str(base) if base else None,
        'asr_device': p.device_used,
        'asr_engine': p.asr_engine_used,
        'download_method': got['method'],
        'model': p.model_source,
        'source_url': info.get('url'),
    }
    if keep_frames or not own_scratch:
        result['frames_dir'] = str(scratch)
    if list_frames:
        result['frame_paths'] = [str(x) for x in frames]
    if subtitle_ocr:
        result['subtitle_ocr'] = ocr_info
        result['subtitle_ocr_path'] = str(ocr_md) if ocr_md else None
    return result


def analyze_and_save(share_link: Optional[str] = None, output_dir: str = 'output',
                     model_name: str = _DEFAULT_MODEL, interval: Optional[int] = None,
                     max_frames: int = 15, *, video_path: Optional[str] = None,
                     device: str = 'auto', quiet: bool = False, keep_frames: bool = True,
                     cols: int = 3, **kw) -> Dict[str, Any]:
    """双线分析并完整落盘：<output_dir>/<video_id>/{transcript.md,contact_sheet.jpg,frames/}。"""
    res = analyze(share_link, model_name=model_name, interval=interval, max_frames=max_frames,
                  video_path=video_path, device=device, quiet=quiet,
                  out_dir=str(Path(output_dir) / '{video_id}'), persist=True,
                  keep_frames=keep_frames, cols=cols, **kw)
    res['output_path'] = res.get('out_dir')
    return res


def extract_text(share_link: Optional[str] = None, output_dir: Optional[str] = None,
                 save_video: bool = False, show_progress: bool = True,
                 model_name: str = _DEFAULT_MODEL, *, video_path: Optional[str] = None,
                 device: str = 'auto', asr: str = 'cn', **kw) -> Dict[str, Any]:
    """只要文案（可选落盘）。"""
    p = DouyinProcessor(model_name=model_name, device=device, asr_engine=asr)
    got = _acquire(p, share_link, video_path, not show_progress, **kw)
    info, vp = got['info'], got['path']
    audio = p.extract_audio(vp, show_progress=show_progress)
    text = p.transcribe_audio(audio, show_progress=show_progress)
    p.cleanup_files(audio)

    result = {'video_info': info, 'text': text, 'language': p.last_detected_language,
              'output_path': None, 'asr_device': p.device_used,
              'asr_engine': p.asr_engine_used,
              'model': p.model_source, 'download_method': got['method']}
    if output_dir:
        folder = Path(output_dir) / str(info['video_id'])
        folder.mkdir(parents=True, exist_ok=True)
        with open(folder / 'transcript.md', 'w', encoding='utf-8') as f:
            f.write(f"# {info['title']}\n\n{text}\n")
        result['output_path'] = str(folder)
        if save_video:
            shutil.copy2(vp, folder / f"{info['video_id']}.mp4")
    if video_path is None:
        p.cleanup_files(vp)
    return result


# ============================================================================
# 6. CLI
# ============================================================================

def _build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description='抖音无水印下载 + 本地 ASR + 抽帧分析 (v3.2)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='示例:\n'
               '  python douyin_downloader.py --link "分享链接" --action analyze\n'
               '  python douyin_downloader.py --link "分享链接" --action save --output out\n'
               '  python douyin_downloader.py --video D:\\v.mp4 --action analyze   # 本地文件，免风控\n'
               '  python douyin_downloader.py --url "<媒体直链>" --action extract\n')
    ap.add_argument('--link', '-l', help='抖音分享链接/分享文本')
    ap.add_argument('--url', help='媒体直链（浏览器里拿到的，直接下载，跳过取流）')
    ap.add_argument('--audio-url', help='音频直链（DASH 分片时与 --url 一起给）')
    ap.add_argument('--video', help='本地视频文件（完全跳过下载，永不被风控）')
    ap.add_argument('--action', '-a', default='analyze',
                    choices=['info', 'download', 'extract', 'analyze', 'save'])
    ap.add_argument('--output', '-o', default='./output', help='save/extract 的输出根目录')
    ap.add_argument('--frames-dir', help='analyze 时帧图目录（默认临时目录，拼完即删）')
    ap.add_argument('--out-dir', help='analyze 落盘目录（默认 ./douyin_out/<video_id>）')
    ap.add_argument('--no-persist', action='store_true', help='不落盘，结果只走 stdout/JSON')
    ap.add_argument('--keep-frames', action='store_true', help='保留下载后的逐帧图')
    ap.add_argument('--keep-video', action='store_true', help='保留下载的 mp4（默认删临时视频）')
    ap.add_argument('--list-frames', action='store_true', help='返回值里带上逐帧路径列表')
    ap.add_argument('--cols', type=int, default=3, help='联系表每行帧数（默认 3）')
    ap.add_argument('--subtitle-ocr', action='store_true',
                    help='对画面底部硬字幕带跑 OCR，额外产出 subtitle_ocr.md'
                         '（字幕图给视觉模型读必错，需要准确字幕时开这个）')
    ap.add_argument('--ocr-fps', type=float, default=2.0, help='OCR 采样帧率（默认 2.0）')
    ap.add_argument('--ocr-bottom', type=float, default=0.22,
                    help='字幕带占画面底部高度比例（默认 0.22）')
    ap.add_argument('--asr', choices=['cn', 'whisper'], default='cn',
                    help='转写引擎：cn=中文引擎（默认，唯一引擎，缺依赖会自动装一次）；'
                         'whisper=只在排障时用')
    ap.add_argument('--model', '-m', default=_DEFAULT_MODEL,
                    help='whisper 模型名或本地目录（默认 small，已预置在 _deps）')
    ap.add_argument('--device', default='auto', choices=['auto', 'cuda', 'cpu'])
    ap.add_argument('--interval', type=int, help='抽帧间隔秒（默认自适应）')
    ap.add_argument('--max-frames', type=int, default=30, help='抽帧上限（默认 30）')
    ap.add_argument('--cookies', help='Netscape 格式 cookies.txt')
    ap.add_argument('--cookies-from-browser', help='如 chrome / "chrome:C:\\path"（浏览器需先关闭）')
    ap.add_argument('--no-browser', action='store_true', help='禁用无登录 headless Chrome 取流')
    ap.add_argument('--browser-timeout', type=int, default=45, help='浏览器取流超时秒（默认 45）')
    ap.add_argument('--browser-profile', help='浏览器 profile 目录（默认临时目录，跨次复用）')
    ap.add_argument('--fresh-profile', action='store_true', help='浏览器 profile 用前清空')
    ap.add_argument('--headed', action='store_true', help='浏览器取流时显示窗口（调试用）')
    ap.add_argument('--json', action='store_true', help='以 JSON 输出结果（便于程序消费）')
    ap.add_argument('--verbose', action='store_true', help='打印取流策略链的每一步（默认安静）')
    ap.add_argument('--quiet', '-q', action='store_true')
    return ap


def main(argv: Optional[List[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    # 默认安静：取流策略链的中间信息不往 stdout 灌，避免污染 Agent 的上下文
    resolve_kw: Dict[str, Any] = {
        'media_url': args.url, 'audio_url': args.audio_url, 'cookies': None,
        'cookies_from_browser': args.cookies_from_browser,
        'use_browser': not args.no_browser, 'browser_timeout': args.browser_timeout,
        'browser_profile': args.browser_profile, 'fresh_profile': args.fresh_profile,
        'headed': args.headed,
    }
    # 默认安静：取流策略链的中间信息不往 stdout 灌，避免污染 Agent 的上下文
    quiet = not args.verbose
    if not any([args.link, args.url, args.video]):
        print('错误：至少要给 --link / --url / --video 之一', file=sys.stderr)
        return EXIT_ENV

    # cookies 先过格式闸：非 Netscape 的（比如插件自己那行原始 cookie 串）在这里转，
    # 转不了就直接拒 —— 绝不能原样交给 yt-dlp，它会把这行内容打进日志。
    if args.cookies:
        try:
            resolve_kw['cookies'] = _cookies_to_netscape(args.cookies)
        except ResolveError as e:
            print(f'\n[错误] {e}', file=sys.stderr)
            print(e.hint, file=sys.stderr)
            if args.json:
                print(json.dumps({'ok': False, 'stage': 'cookies', 'error': str(e)},
                                 ensure_ascii=False))
            _cleanup_temp_cookies()
            return EXIT_RESOLVE

    try:
        if args.action == 'info':
            p = DouyinProcessor(model_name=args.model, device=args.device,
                        asr_engine=getattr(args, 'asr', 'cn'))
            info = p.resolve(args.link or '', quiet=quiet, **resolve_kw)
            print(json.dumps(info, ensure_ascii=False, indent=1) if args.json else
                  f"标题: {info['title']}\nID: {info['video_id']}\n"
                  f"取流方式: {info.get('source')}\n直链: {str(info.get('url'))[:120]}")
            return EXIT_OK

        if args.action == 'download':
            path = download_video(args.link, args.output, model_name=args.model,
                                  quiet=quiet, **resolve_kw)
            print(json.dumps({'video_path': str(path)}, ensure_ascii=False) if args.json
                  else f'已保存: {path}')
            return EXIT_OK

        if args.action == 'extract':
            res = extract_text(args.link, output_dir=args.output, save_video=False,
                               show_progress=not quiet, model_name=args.model, quiet=quiet,
                               video_path=args.video, device=args.device, **resolve_kw)
            if args.json:
                print(json.dumps(res, ensure_ascii=False, indent=1))
            else:
                print(res['text'])
                if res.get('output_path'):
                    print(f"\n已保存: {res['output_path']}")
            return EXIT_OK

        if args.action == 'save':
            res = analyze_and_save(args.link, output_dir=args.output, model_name=args.model,
                                   interval=args.interval, max_frames=args.max_frames,
                                   video_path=args.video, device=args.device,
                                   quiet=quiet, keep_frames=True,
                                   cols=args.cols, subtitle_ocr=args.subtitle_ocr,
                                   ocr_fps=args.ocr_fps,
                                   ocr_bottom_ratio=args.ocr_bottom, **resolve_kw)
            print(json.dumps(res, ensure_ascii=False, indent=1) if args.json else
                  f"产物目录: {res['output_path']}\n取流: {res['download_method']}\n"
                  f"ASR: {res['asr_device']} | 帧数: {res['frame_count']}\n"
                  f"联系表: {res['contact_sheet']}\n文案: {res['transcript']}\n\n{res['text'][:400]}")
            return EXIT_OK

        # analyze（默认）
        res = analyze(args.link, model_name=args.model,
                      interval=args.interval, max_frames=args.max_frames,
                      video_path=args.video, device=args.device, quiet=quiet,
                      out_dir=args.out_dir, persist=not args.no_persist,
                      keep_frames=args.keep_frames, keep_video=args.keep_video,
                      cols=args.cols, list_frames=args.list_frames,
                      subtitle_ocr=args.subtitle_ocr, ocr_fps=args.ocr_fps,
                      ocr_bottom_ratio=args.ocr_bottom, **resolve_kw)
        if args.json:
            print(json.dumps(res, ensure_ascii=False, indent=1))
        else:
            print(f"标题: {res['title']}")
            print(f"取流: {res['download_method']} | ASR: {res['asr_device']} | "
                  f"时长: {res['duration_s']}s | 帧数: {res['frame_count']}")
            print(f"联系表: {res['contact_sheet']}")
            print(f"文案: {res['transcript']}（{res['text_chars']} 字，已落盘，重问不必重跑）")
            print(f"\n--- 文案 ---\n{res['text']}")
        return EXIT_OK

    except ResolveError as e:
        print(f'\n[取流失败] {e}', file=sys.stderr)
        print(f'\n{e.hint}', file=sys.stderr)
        if args.json:
            print(json.dumps({'ok': False, 'stage': 'resolve', 'error': str(e),
                              'hint': e.hint}, ensure_ascii=False))
        return EXIT_RESOLVE
    except Exception as e:  # noqa: BLE001
        print(f'\n[错误] {type(e).__name__}: {e}', file=sys.stderr)
        if args.json:
            print(json.dumps({'ok': False, 'error': f'{type(e).__name__}: {e}'},
                             ensure_ascii=False))
        return EXIT_ASR if 'whisper' in str(e).lower() else 1


if __name__ == '__main__':
    sys.exit(main())
