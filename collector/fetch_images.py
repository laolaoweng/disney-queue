#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓每个游乐项目的官方图片（WAM facility/detail 里的方形图/大图）。

只读官方元数据，不会碰排队接口；30 个项目、每个请求间隔 0.7s，避免触发 WAF。
产物：
  raw/facility_detail/<attractionId>.json  原始响应（缓存，重跑时跳过）
  data/images.json                        { attractionId: { square, hero, title } }

用法：
  python collector/fetch_images.py                 # 增量：已有的跳过
  python collector/fetch_images.py --force         # 全部重抓
  python collector/fetch_images.py --sleep 0.7     # 调整请求间隔
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = ROOT / "raw" / "facility_detail"

DETAIL_URL = "https://cu.apigw.shanghaidisneyresort.com/steamboat-wam/api/rap/facility/detail"
HEADERS = {
    "client": "WEB",
    "Origin": "https://www.shanghaidisneyresort.com",
    "Referer": "https://www.shanghaidisneyresort.com/",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) disney-queue-collector/1.0",
}
UA_ONLY = {"User-Agent": HEADERS["User-Agent"], "Referer": "https://www.shanghaidisneyresort.com/"}


def load_json(path: pathlib.Path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: pathlib.Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")
    tmp.replace(path)


def post_detail(attraction_id: str, timeout: float = 25.0):
    body = json.dumps(
        {
            "entityId": attraction_id,
            "entityType": "Attraction",
            "facilityId": f"{attraction_id};entityType=Attraction;destination=shdr",
        }
    ).encode("utf-8")
    req = urllib.request.Request(DETAIL_URL, data=body, headers=HEADERS, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def pick_media(detail: dict) -> dict:
    data = (detail.get("data") or {}).get("data") or {}
    media = data.get("media") or {}

    def url_of(key: str) -> str:
        item = media.get(key) or {}
        return str(item.get("url") or "")

    square = url_of("finderListMobileSquare") or url_of("mapBubbleThumbLarge") or url_of("finderStandardThumb")
    hero = url_of("finderDetailMobileHero") or url_of("finderDetailNarrowHero") or url_of("finderStandardThumb")
    return {
        "square": square,
        "hero": hero,
        "title": str(data.get("name") or ""),
    }


def check_image(url: str) -> tuple[bool, int, str]:
    """确认图片在现网可下载（返回 是否200 / 字节数 / content-type）。"""
    if not url:
        return False, 0, ""
    try:
        req = urllib.request.Request(url, headers=UA_ONLY)
        with urllib.request.urlopen(req, timeout=20) as resp:
            blob = resp.read()
            return resp.status == 200, len(blob), resp.headers.get("Content-Type", "")
    except Exception as exc:  # noqa: BLE001
        return False, 0, f"ERR {exc}"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="抓官方项目图片")
    parser.add_argument("--force", action="store_true", help="忽略缓存，全部重抓")
    parser.add_argument("--sleep", type=float, default=0.7, help="每次请求间隔秒数")
    parser.add_argument("--no-check", action="store_true", help="不验证图片可下载")
    args = parser.parse_args(argv)

    catalog = load_json(DATA / "catalog.json")
    attractions = catalog.get("attractions") or []
    if not attractions:
        print("catalog.json 里没有 attractions", file=sys.stderr)
        return 2

    RAW.mkdir(parents=True, exist_ok=True)
    images: dict = {}
    failures = []
    fetched = 0
    for i, att in enumerate(attractions, 1):
        aid = att["id"]
        cache = RAW / f"{aid}.json"
        detail = None
        if cache.exists() and not args.force:
            try:
                detail = load_json(cache)
            except Exception:  # noqa: BLE001
                detail = None
        if detail is None:
            try:
                detail = post_detail(aid)
                write_json(cache, detail)
                fetched += 1
                time.sleep(max(0.0, args.sleep))
            except Exception as exc:  # noqa: BLE001
                failures.append((aid, f"detail 请求失败 {exc}"))
                print(f"[{i}/{len(attractions)}] {aid} 详情失败：{exc}", file=sys.stderr)
                continue
        item = pick_media(detail)
        if not item["square"]:
            failures.append((aid, "没有方形图 URL"))
            print(f"[{i}/{len(attractions)}] {aid} 没有方形图", file=sys.stderr)
            continue
        if not args.no_check:
            ok, size, ctype = check_image(item["square"])
            if not ok:
                failures.append((aid, f"图片不可下载 {ctype}"))
                print(f"[{i}/{len(attractions)}] {aid} 图片不可下载：{ctype}", file=sys.stderr)
                continue
            item["bytes"] = size
            item["contentType"] = ctype
        images[aid] = item
        print(f"[{i}/{len(attractions)}] {aid} ok {item['square'].rsplit('/', 1)[-1]}")

    out = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "wam/facility/detail",
        "images": images,
    }
    write_json(DATA / "images.json", out)
    print(f"\n完成：{len(images)}/{len(attractions)} 个项目有图片，本次新抓 {fetched} 个详情")
    if failures:
        print(f"失败 {len(failures)} 个：")
        for aid, why in failures:
            print(f"  - {aid}: {why}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
