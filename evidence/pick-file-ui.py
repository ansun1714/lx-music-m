# -*- coding: utf-8 -*-
"""系统文件选择器 UI 自动化：在 ACTION_OPEN_DOCUMENT 界面中选中
/sdcard/Download/真机导入测试.js，用于验证 v3.1.1 的本地音源导入修复。"""
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

ADB = r"C:\Users\maoxu\tools\android-sdk\platform-tools\adb.exe"
TARGET = "真机导入测试.js"


def sh(*args):
    return subprocess.run([ADB] + list(args), capture_output=True,
                          text=True, encoding="utf-8", errors="replace").stdout or ""


def top():
    for line in sh("shell", "dumpsys activity activities").splitlines():
        if "topResumedActivity" in line:
            return line.strip()
    return ""


def dump_nodes():
    sh("shell", "uiautomator dump /sdcard/lx-ui.xml")
    out = subprocess.run([ADB, "shell", "cat /sdcard/lx-ui.xml"],
                         capture_output=True).stdout.decode("utf-8", "replace")
    i = out.find("<?xml")
    if i < 0:
        return []
    try:
        return list(ET.fromstring(out[i:]).iter("node"))
    except Exception:
        return []


def label(n):
    return ((n.get("text") or "").strip() or (n.get("content-desc") or "").strip())


def center(n):
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", n.get("bounds", ""))
    if not m:
        return None
    x1, y1, x2, y2 = map(int, m.groups())
    return (x1 + x2) // 2, (y1 + y2) // 2


def tap(n, why):
    c = center(n)
    if not c:
        return False
    print("  tap  %-26s bounds=%-24s -> (%d,%d)" % (why, n.get("bounds"), c[0], c[1]))
    sh("shell", "input tap %d %d" % c)
    return True


def find(nodes, pred):
    return next((n for n in nodes if pred(label(n))), None)


def main():
    print("=== 等待系统文件选择器弹出 ===")
    ok = False
    for i in range(20):
        t = top()
        if "documentsui" in t.lower():
            print("  已弹出:", t)
            ok = True
            break
        time.sleep(0.6)
    if not ok:
        print("  FAIL 文件选择器未弹出，当前:", top())
        return 1

    picked = False
    for round_no in range(14):
        time.sleep(0.9)
        nodes = dump_nodes()
        texts = [label(n) for n in nodes if label(n)]
        print("  [round %d] %s" % (round_no, texts[:16]))

        # 必须精确匹配文件名 text；模糊匹配会命中缩略图的
        # content-desc="Preview the file ..."，点它只会打开预览而不返回 URI。
        hit = find(nodes, lambda s: s == TARGET)
        # 注意：Element 的布尔值取决于子元素个数，必须用 is not None 判断
        if hit is not None:
            tap(hit, TARGET)
            picked = True
            break

        root_btn = find(nodes, lambda s: s.lower() in ("show roots", "显示根目录"))
        dl = find(nodes, lambda s: s.strip().lower() in
                  ("download", "downloads", "下载", "下载内容"))
        storage = find(nodes, lambda s: "内部存储" in s or "internal storage" in s
                       or "primary" in s.lower() or "pixel" in s.lower())
        if dl is not None:
            tap(dl, "下载目录")
        elif root_btn is not None:
            tap(root_btn, "打开根目录侧栏")
        elif storage is not None:
            tap(storage, "内部存储")
        elif "documentsui" not in top().lower():
            print("  选择器已关闭")
            break
    if not picked:
        print("  FAIL 未找到目标文件")
        return 1

    print("=== 等待返回应用 ===")
    for i in range(20):
        t = top()
        if "com.lxmusic.replica" in t:
            print("  已返回应用:", t)
            return 0
        time.sleep(0.6)
    print("  WARN 未检测到返回应用:", top())
    return 0


if __name__ == "__main__":
    sys.exit(main())
