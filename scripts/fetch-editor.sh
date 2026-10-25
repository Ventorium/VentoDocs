#!/usr/bin/env bash
# 拉取在线编辑器（ranuts/document，AGPL-3.0）官方预构建镜像中的静态资源，
# 放入 VENTO_EDITOR_DIST 目录（默认 editor-dist/），供 vento 以 /editor/** 路由服务。
#
# 用法：
#   bash scripts/fetch-editor.sh
#
# 依赖：Docker（用于 docker pull / docker cp，无需启动容器）。
# 说明：
#   - 官方镜像 = node 构建产物 dist + static-web-server，静态资源位于镜像内 /public。
#   - 拉取后自动移除 Service Worker（sw.js）。官方 SPA 在 JS bundle 内注册
#     ./sw.js，删除该文件后注册静默失败，避免 SW 缓存干扰版本更新。
#   - 产物约 460MB，已 gitignore，不入仓库。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${RANUTS_IMAGE:-ghcr.io/ranuts/document:0.0.4}"
OUT_DIR="${VENTO_EDITOR_DIST:-editor-dist}"
case "$OUT_DIR" in
  /*) ;;
  *) OUT_DIR="$REPO_ROOT/$OUT_DIR" ;;
esac

echo "==> 拉取镜像 $IMAGE（慢速网络下自动重试 5 次）"
ok=0
for i in 1 2 3 4 5; do
  if docker pull "$IMAGE"; then ok=1; break; fi
  echo "!! 第 $i 次拉取失败，5 秒后重试…"
  sleep 5
done
if [ "$ok" != "1" ]; then
  echo "错误：镜像拉取失败。可稍后重试，或手动 docker pull $IMAGE 后重跑本脚本。" >&2
  exit 1
fi

TMP_CID="$(docker create "$IMAGE")"
trap 'docker rm -f "$TMP_CID" >/dev/null 2>&1 || true' EXIT

echo "==> 提取静态资源 /public → $OUT_DIR"
mkdir -p "$OUT_DIR"
docker cp "$TMP_CID":/public/. "$OUT_DIR"/

echo "==> 移除 Service Worker（删除 sw.js；SPA bundle 内对其的注册会静默失败）"
rm -f "$OUT_DIR/sw.js" "$OUT_DIR/sw-register.js"

echo "==> 校验关键文件"
fail=0
for f in index.html wasm/x2t/x2t.wasm.br sdkjs web-apps; do
  if [ -e "$OUT_DIR/$f" ]; then
    echo "   OK  $f"
  else
    echo "   缺失 $f" >&2
    fail=1
  fi
done
if [ -f "$OUT_DIR/sw.js" ]; then
  echo "   未删除 sw.js" >&2
  fail=1
fi
if [ "$fail" != "0" ]; then
  echo "错误：关键文件缺失，编辑器资源不完整。" >&2
  exit 1
fi

echo "==> 完成。大小：$(du -sh "$OUT_DIR" | cut -f1)"
echo "启动 vento 时将自动检测该目录（VENTO_EDITOR_DIST 可覆盖），缺失 index.html 时编辑器降级禁用。"
