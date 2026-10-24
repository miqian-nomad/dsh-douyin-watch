#!/usr/bin/env python
# -*- coding: utf-8 -*-
# ⚠️ 已弃用（2026-10-24）：被 tools/notice-read.mjs 取代（纯 Node，不再需要 curl_cffi）。
#    保留此文件仅为历史参考；index.js 默认不会调用它。
"""
tools/notice-read.py —— 读抖音互动通知（@ 我的 / 评论 / 点赞 / 关注 / 粉丝）
============================================================================
关键（踩了很久才摸出来）：
  · 列表在响应的 **notice_list_v2** 里，不是 notice_list
  · 必须**同时**给 `group` 和 `notice_group` 两个参数，缺一个就 status_code=5
  · `min_time=0` 才会把历史拉出来
  · 网页端**没有**通知中心页面（/notice /notification /message /interaction 全 404），
    所以只能走这个接口

只读：is_mark_read=0（不把消息标成已读）

用法:
  python tools/notice-read.py            # 输出干净的 JSON
  python tools/notice-read.py --raw      # 连原始条目一起给
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _home import home_str  # noqa: E402
import time

from curl_cffi import requests as creq

HOME = home_str()
COOKIE = open(os.path.join(HOME, "douyin_cookie.txt"), encoding="utf-8").read().strip()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
BASE = "https://www.douyin.com"
COMMON = ("device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1"
          "&version_code=190500&version_name=19.5.0&cookie_enabled=true"
          "&screen_width=1920&screen_height=1080&browser_language=zh-CN"
          "&browser_platform=Win32&browser_name=Chrome&browser_version=141.0.0.0"
          "&engine_name=Blink&engine_version=141.0.0.0&os_name=Windows&os_version=10"
          "&platform=PC")

# 通知类型（实测 + 推断）
TYPE_NAME = {
    33: "关注了你",
    34: "点赞了你的作品",
    35: "评论了你的作品",
    45: "@了你（评论区）",
    46: "@了你（作品）",
}

GROUPS = [700, 960, 401, 601]
RAW = "--raw" in sys.argv


def norm(it):
    """把一条通知压成人类可读的形状"""
    t = it.get("type")
    rec = {"type": t, "type_name": TYPE_NAME.get(t, "type_%s" % t), "nid": it.get("nid"), "create_time": it.get("create_time")}
    for key in ("at", "comment", "digg", "follow", "fans", "im", "system"):
        blk = it.get(key)
        if not isinstance(blk, dict):
            continue
        ui = blk.get("user_info") or blk.get("from_user") or {}
        rec["nickname"] = ui.get("nickname") or ""
        rec["uid"] = ui.get("uid") or ""
        rec["content"] = (blk.get("content") or "").strip()
        sch = blk.get("schema_url") or ""
        rec["schema_url"] = sch
        # aweme://aweme/detail/<aweme_id>?cid=<comment_id>
        if "aweme/detail/" in sch:
            try:
                rec["aweme_id"] = sch.split("aweme/detail/")[1].split("?")[0].split("&")[0]
            except Exception:
                pass
            if "cid=" in sch:
                rec["comment_id"] = sch.split("cid=")[1].split("&")[0]
        if blk.get("aweme_id"):
            rec.setdefault("aweme_id", str(blk["aweme_id"]))
        if rec.get("aweme_id"):
            rec["video_url"] = "https://www.douyin.com/video/%s" % rec["aweme_id"]
            if rec.get("comment_id"):
                rec["comment_url"] = "https://www.douyin.com/video/%s?comment_id=%s" % (rec["aweme_id"], rec["comment_id"])
        break
    if RAW:
        rec["raw"] = it
    return rec


def main():
    out = {"ok": True, "counts": {}, "items": []}
    with creq.Session(impersonate="chrome") as s:
        s.headers.update({"User-Agent": UA, "Cookie": COOKIE, "Referer": BASE + "/"})
        try:
            cj = s.get(BASE + "/aweme/v1/web/notice/count/?" + COMMON + "&is_new_notice=1&need_social_count=1", timeout=20).json()
            for c in cj.get("notice_count") or []:
                out["counts"][str(c.get("group"))] = c.get("count")
        except Exception as e:
            out.setdefault("warnings", []).append("count 失败: " + str(e)[:120])
        time.sleep(1.0)

        seen = set()
        for g in GROUPS:
            q = "is_new_notice=1&is_mark_read=0&count=20&min_time=0&group=%d&notice_group=%d" % (g, g)
            try:
                j = s.get(BASE + "/aweme/v1/web/notice/?" + COMMON + "&" + q, timeout=20).json()
                if j.get("status_code") not in (0, None):
                    out.setdefault("warnings", []).append("group=%s status_code=%s" % (g, j.get("status_code")))
                for it in j.get("notice_list_v2") or []:
                    nid = it.get("nid")
                    if nid in seen:
                        continue
                    seen.add(nid)
                    r = norm(it)
                    r["group"] = g
                    out["items"].append(r)
            except Exception as e:
                out.setdefault("warnings", []).append("group=%s %s" % (g, str(e)[:100]))
            time.sleep(1.2)

    out["items"].sort(key=lambda x: x.get("create_time") or 0, reverse=True)
    out["n"] = len(out["items"])
    out["at_n"] = len([x for x in out["items"] if x.get("type") in (45, 46)])
    print(json.dumps(out, ensure_ascii=False, indent=1))
    with open(os.path.join(HOME, "notice.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
