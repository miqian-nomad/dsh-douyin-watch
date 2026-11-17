#!/usr/bin/env node
/**
 * 抖音媒体直链抓取器 —— 供 douyin_downloader.py 调用（v1，2026-09-22）
 *
 * 为什么需要它：
 *   抖音已把播放地址从 HTML 里移除，改由签名接口下发（a_bogus/msToken 那套），
 *   纯 HTTP 请求会吃风控页、yt-dlp 会报 "Fresh cookies ... are needed"。
 *   唯一直链来源是浏览器里播放器的实际请求（performance resource entries）。
 *   本脚本用插件自带的 playwright-core 起一个**独立 profile 的无登录 headless Chrome**
 *   （不需要 cookie、不需要登录、不占用 DSH 正在用的那个浏览器 profile），
 *   打开视频页，从播放器请求里读出带签名的 video/audio 直链。
 *
 * 用法：
 *   node fetch_media_urls.mjs --url <页面/分享URL> --out <结果JSON路径>
 *        [--timeout 45] [--headed] [--profile <dir>] [--fresh-profile]
 *
 * 无论成功失败都会写 --out 指定的 JSON（stdout 不保证可被管道捕获，故用文件传递）：
 *   {ok, title, desc, duration, video_url, audio_url, media_all, captcha, elapsed_ms, error}
 * 退出码：0 成功 / 1 失败（细节看 JSON）
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[k] = next;
      i += 1;
    } else {
      out[k] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const targetUrl = args.url;
const outPath = args.out || join(tmpdir(), 'douyin_media.json');
const timeoutMs = Math.max(10, Number(args.timeout) || 45) * 1000;
const headless = !args.headed;
const freshProfile = Boolean(args['fresh-profile']);
// profile 候选：显式指定 > 环境变量 > 临时目录 > 当前目录（受限沙箱下临时目录可能不可写）
const profileCandidates = args.profile
  ? [args.profile]
  : [
    process.env.DOUYIN_BROWSER_PROFILE,
    join(tmpdir(), 'douyin-skill-browser-profile'),
    join(process.cwd(), '.douyin-browser-profile'),
  ].filter(Boolean);

function writeResult(payload) {
  try {
    mkdirSync(join(outPath, '..'), { recursive: true });
  } catch { /* ignore */ }
  writeFileSync(outPath, JSON.stringify(payload, null, 1), 'utf8');
}

function loadPlaywright() {
  const roots = [
    process.env.DOUYIN_PLAYWRIGHT_ROOT,
    'D:/dsh-plugins/dsh-browser-playwright',
  ].filter(Boolean);
  const errors = [];
  for (const r of roots) {
    try {
      const req = createRequire(join(r, 'package.json'));
      return req('playwright-core');
    } catch (e) {
      errors.push(`${r}: ${e.message}`);
    }
  }
  try {
    const req = createRequire(import.meta.url);
    return req('playwright-core');
  } catch (e) {
    errors.push(`local: ${e.message}`);
  }
  throw new Error(`playwright-core 未找到（可设 DOUYIN_PLAYWRIGHT_ROOT 指向插件目录）: ${errors.join(' | ')}`);
}

async function launchContext(chromium, profileDir) {
  const base = {
    headless,
    viewport: { width: 1440, height: 900 },
    userAgent: UA,
    locale: 'zh-CN',
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--mute-audio',
      '--disable-features=Translate,MediaRouter',
    ],
  };
  const candidates = [];
  if (process.env.DOUYIN_CHROME) candidates.push({ executablePath: process.env.DOUYIN_CHROME });
  candidates.push({ channel: 'chrome' }, { channel: 'msedge' });
  candidates.push({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  candidates.push({ executablePath: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe' });
  candidates.push({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });

  const errors = [];
  for (const c of candidates) {
    try {
      const ctx = await chromium.launchPersistentContext(profileDir, { ...base, ...c });
      return { ctx, mode: c.channel ? `channel:${c.channel}` : `exe:${c.executablePath}` };
    } catch (e) {
      errors.push(`${profileDir} + ${c.channel || c.executablePath}: ${String(e.message).split('\n')[0]}`);
    }
  }
  throw new Error(`无法启动浏览器: ${errors.join(' | ')}`);
}

const collect = () => {
  const rs = performance.getEntriesByType('resource').map((e) => e.name);
  const media = Array.from(new Set(rs.filter((u) => /douyinvod|zjcdn|\/video\/tos/.test(u))));
  const pick = (re) => media.find((u) => re.test(u)) || null;
  const v = document.querySelector('video');
  const txt = (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 800);
  const meta = (n) => {
    const el = document.querySelector(`meta[name="${n}"],meta[property="${n}"]`);
    return el ? el.content : null;
  };
  return {
    title: document.title || null,
    desc: meta('description') || meta('og:description'),
    video_url: pick(/media-video/),
    audio_url: pick(/media-audio/),
    media_all: media,
    has_video_el: Boolean(v),
    video_src: v ? String(v.src).slice(0, 80) : null,
    duration: v && Number.isFinite(v.duration) ? Math.round(v.duration) : null,
    captcha: /验证|滑块|拖动|完成验证|安全验证/.test(txt),
  };
};

const started = Date.now();

async function main() {
  if (!targetUrl) throw new Error('缺少 --url');
  const { chromium } = loadPlaywright();
  const launchErrors = [];
  for (const profileDir of profileCandidates) {
    if (freshProfile) {
      try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    let ctx;
    let mode;
    try {
      ({ ctx, mode } = await launchContext(chromium, profileDir));
    } catch (e) {
      launchErrors.push(String(e.message).split('\n')[0]);
      continue;
    }
    try {
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(60000, timeoutMs) })
        .catch((e) => { /* 继续轮询，页面可能已部分可用 */ void e; });

      let info = null;
      let triedPlay = false;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        info = await page.evaluate(collect).catch(() => null);
        if (info && info.video_url && info.audio_url) break;
        if (!triedPlay) {
          triedPlay = true;
          await page.evaluate(() => {
            const v = document.querySelector('video');
            if (v) { v.muted = true; if (v.play) v.play().catch(() => {}); }
          }).catch(() => {});
        }
        await page.waitForTimeout(1500);
      }
      if (!info) throw new Error('页面信息读取失败');
      const ok = Boolean(info.video_url);
      writeResult({ ok, elapsed_ms: Date.now() - started, launch: mode, profile: profileDir, ...info });
      return ok ? 0 : 1;
    } finally {
      await ctx.close().catch(() => {});
    }
  }
  throw new Error(`所有 profile 都无法启动浏览器: ${launchErrors.join(' | ')}`);
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    writeResult({ ok: false, elapsed_ms: Date.now() - started, profiles: profileCandidates, error: String(e.message || e) });
    process.exit(1);
  });
