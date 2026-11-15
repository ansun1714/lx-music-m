# -*- coding: utf-8 -*-
"""一键构建 LX Music v1.9.2 界面复现版 v3.11.0 签名 APK（无 Gradle、构建过程不联网）。

链路：standalone.html -> assets/index.html -> aapt2 compile/link -> javac -> d8
      -> 合并 classes.dex -> zipalign -> keytool -> apksigner -> 校验 -> 输出
用法：python android/build.py
"""
import os
import sys
import glob
import shutil
import tempfile
import zipfile
import hashlib
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
APP = os.path.join(ROOT, "app")
# aapt2 / zipalign 是原生程序，在中文路径下无法打开目录（"Illegal byte sequence" /
# "系统找不到指定的文件"）。所有中间产物放在纯 ASCII 工作目录，只有最终 APK 落回项目根目录。
# CI 用 LX_BUILD_WORK 指到 $RUNNER_TEMP，本地默认 %TEMP%\lx-build
WORK = os.environ.get("LX_BUILD_WORK") or os.path.join(tempfile.gettempdir(), "lx-build")
OUT = WORK
ASSETS = os.path.join(OUT, "assets")
CLASSES = os.path.join(OUT, "classes")
DEX = os.path.join(OUT, "dex")
RES_COPY = os.path.join(OUT, "res")
# 密钥放在稳定的 ASCII 路径，不随 out/ 清理，保证重建后签名一致、可覆盖安装
KEYSTORE_DIR = os.environ.get("LX_KEYSTORE_DIR") or os.path.join(
    tempfile.gettempdir(), "lx-replica-keystore")
KEYSTORE = os.path.join(KEYSTORE_DIR, "lx-replica.jks")
STORE_PASS = os.environ.get("LX_KS_PASS", "lxmusic-replica")
KEY_PASS = STORE_PASS
ALIAS = os.environ.get("LX_KS_ALIAS", "lxreplica")

# SDK 位置：环境变量优先（GitHub Actions / macOS / Linux），本地回落到固定路径
SDK = (os.environ.get("ANDROID_SDK_ROOT") or os.environ.get("ANDROID_HOME") or
       r"C:\Users\maoxu\tools\android-sdk")
BT_VER = os.environ.get("ANDROID_BUILD_TOOLS_VERSION", "35.0.0")
# 必须 35.0.0（或更高）：34.0.0 的 R8 在 JDK21 下会 NPE
EXE = ".exe" if os.name == "nt" else ""
BT = os.path.join(SDK, "build-tools", BT_VER)
PLATFORM = os.path.join(SDK, "platforms", "android-34")
ANDROID_JAR = os.path.join(PLATFORM, "android.jar")
AAPT2 = os.path.join(BT, "aapt2" + EXE)
AAPT = os.path.join(BT, "aapt" + EXE)
ZIPALIGN = os.path.join(BT, "zipalign" + EXE)
D8_JAR = os.path.join(BT, "lib", "d8.jar")
APKSIGNER_JAR = os.path.join(BT, "lib", "apksigner.jar")

VERSION_NAME = os.environ.get("LX_VERSION_NAME", "3.13.7")
VERSION_CODE = os.environ.get("LX_VERSION_CODE", "24")
FINAL_APK = os.environ.get("LX_FINAL_APK") or os.path.join(
    ROOT, "LXMusic-v%s.apk" % VERSION_NAME)


def preflight():
    """构建前把缺的组件一次性列清楚，CI 里报错比半路炸好定位。"""
    need = [AAPT2, ZIPALIGN, D8_JAR, APKSIGNER_JAR, ANDROID_JAR]
    missing = [p for p in need if not os.path.exists(p)]
    if missing:
        raise RuntimeError(
            "缺少构建组件（SDK=%s, build-tools=%s）：\n  %s\n"
            "可用 ANDROID_SDK_ROOT / ANDROID_BUILD_TOOLS_VERSION 指定。"
            % (SDK, BT_VER, "\n  ".join(missing)))



def run(args, cwd=None, check=True):
    print("  $ " + " ".join(str(a) for a in args[:6]) + (" ..." if len(args) > 6 else ""))
    p = subprocess.run([str(a) for a in args], cwd=cwd,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = p.stdout.decode("utf-8", "replace")
    if out.strip():
        for line in out.strip().splitlines()[:20]:
            print("    " + line)
    if check and p.returncode != 0:
        raise RuntimeError("命令失败 (%d): %s" % (p.returncode, args[0]))
    return p.returncode, out


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    preflight()
    print("== 1/9 准备单文件版与 assets ==")
    print("    SDK %s (build-tools %s)" % (SDK, BT_VER))
    standalone = os.path.join(APP, "standalone.html")
    if not os.path.exists(standalone):
        run(["node", os.path.join(ROOT, "evidence", "build-standalone.js")], cwd=ROOT)
    patch = open(os.path.join(HERE, "bridge-patch.js"), "r", encoding="utf-8").read()
    html = open(standalone, "r", encoding="utf-8").read()
    if "</body>" not in html:
        raise RuntimeError("standalone.html 缺少 </body>")
    html = html.replace("</body>", "<script>\n" + patch + "\n</script>\n</body>")

    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    for d in (ASSETS, CLASSES, DEX, KEYSTORE_DIR):
        os.makedirs(d, exist_ok=True)
    shutil.copytree(os.path.join(HERE, "res"), RES_COPY)
    shutil.copy2(os.path.join(HERE, "AndroidManifest.xml"),
                 os.path.join(OUT, "AndroidManifest.xml"))
    with open(os.path.join(ASSETS, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)
    print("    assets/index.html %d 字符（含 APK 专用桥接补丁）" % len(html))

    print("== 2/9 aapt2 compile 资源 ==")
    res_zip = os.path.join(OUT, "res.zip")
    run([AAPT2, "compile", "--dir", RES_COPY, "-o", res_zip])

    print("== 3/9 aapt2 link 生成 base.apk ==")
    base_apk = os.path.join(OUT, "base.apk")
    run([AAPT2, "link", "-o", base_apk, "-I", ANDROID_JAR,
         "--manifest", os.path.join(OUT, "AndroidManifest.xml"),
         "-R", res_zip, "-A", ASSETS, "--auto-add-overlay",
         "--min-sdk-version", "23", "--target-sdk-version", "34",
         "--version-code", VERSION_CODE, "--version-name", VERSION_NAME])

    print("== 4/9 javac 编译 Java 源码 ==")
    SRC_COPY = os.path.join(OUT, "src")
    shutil.copytree(os.path.join(HERE, "src"), SRC_COPY)
    sources = glob.glob(os.path.join(SRC_COPY, "**", "*.java"), recursive=True)
    if not sources:
        raise RuntimeError("没有找到 Java 源码")
    run(["javac", "-encoding", "UTF-8", "-source", "8", "-target", "8",
         "-nowarn", "-classpath", ANDROID_JAR, "-d", CLASSES] + sources)

    print("== 5/9 d8 生成 classes.dex ==")
    class_files = glob.glob(os.path.join(CLASSES, "**", "*.class"), recursive=True)
    run(["java", "-cp", D8_JAR, "com.android.tools.r8.D8",
         "--lib", ANDROID_JAR, "--min-api", "23", "--output", DEX] + class_files)
    dex_path = os.path.join(DEX, "classes.dex")
    if not os.path.exists(dex_path):
        raise RuntimeError("d8 未生成 classes.dex")

    print("== 6/9 合并 dex 并对齐 ==")
    unsigned = os.path.join(OUT, "unsigned.apk")
    shutil.copyfile(base_apk, unsigned)
    with zipfile.ZipFile(unsigned, "a", zipfile.ZIP_DEFLATED) as z:
        z.write(dex_path, "classes.dex")
    aligned = os.path.join(OUT, "aligned.apk")
    run([ZIPALIGN, "-f", "-p", "4", unsigned, aligned])

    print("== 7/9 签名密钥 ==")
    if not os.path.exists(KEYSTORE):
        run(["keytool", "-genkeypair", "-keystore", KEYSTORE,
             "-storetype", "JKS", "-storepass", STORE_PASS, "-keypass", KEY_PASS,
             "-alias", ALIAS, "-keyalg", "RSA", "-keysize", "2048",
             "-validity", "10000",
             "-dname", "CN=LX Music Replica, OU=Rebuild, O=Rebuild, L=Shenzhen, ST=GD, C=CN"])
        print("    新建密钥：" + KEYSTORE + "（稳定路径，重建不会变化）")
    else:
        print("    复用已有密钥")

    print("== 8/9 apksigner 签名 ==")
    if os.path.exists(FINAL_APK):
        os.remove(FINAL_APK)
    run(["java", "-jar", APKSIGNER_JAR, "sign",
         "--ks", KEYSTORE, "--ks-pass", "pass:" + STORE_PASS,
         "--key-pass", "pass:" + KEY_PASS, "--ks-key-alias", ALIAS,
         "--v1-signing-enabled", "true", "--v2-signing-enabled", "true",
         "--v3-signing-enabled", "true", "--min-sdk-version", "23",
         "--out", FINAL_APK, aligned])

    print("== 9/9 校验 ==")
    run(["java", "-jar", APKSIGNER_JAR, "verify", "--verbose", FINAL_APK])
    # aapt 在中文路径会报 Illegal byte sequence，复制到纯 ASCII 路径再 dump
    tmp = os.path.join(WORK, "badging.apk")
    shutil.copyfile(FINAL_APK, tmp)
    rc, badging = run([AAPT, "dump", "badging", tmp], check=False)
    for line in badging.splitlines():
        if line.startswith("package:") or "application-label:" in line or "sdkVersion" in line:
            print("    " + line)
    with zipfile.ZipFile(FINAL_APK) as z:
        names = z.namelist()
    print("    APK 条目数 %d，含 assets/index.html: %s，含 classes.dex: %s" %
          (len(names), "assets/index.html" in names, "classes.dex" in names))
    size = os.path.getsize(FINAL_APK)
    print("\n完成：%s" % FINAL_APK)
    print("  大小   %d B" % size)
    print("  SHA256 %s" % sha256(FINAL_APK))
    print("  版本   %s (versionCode %s)" % (VERSION_NAME, VERSION_CODE))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print("\n[构建失败] %s" % e)
        sys.exit(1)
