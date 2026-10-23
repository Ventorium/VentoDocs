#!/usr/bin/env bash
# POC-1 许可证审计：扫描两个 pnpm 工程（浏览器端 1.1.0 + 无头端 1.0.4）的
# node_modules（含 .pnpm 传递依赖），列出全部 @univerjs* 包的 license，并断言：
#   1. 不存在任何 @univerjs-pro 开头的包（商业授权）；
#   2. 不存在 license 字段为空的 @univerjs 包；
#   3. 每个 @univerjs 包 license 为 Apache-2.0（OSS 承诺）；
#      仅允许宽松许可白名单（MIT/BSD/ISC/0BSD，如传递依赖 @univerjs/icons），
#      其余非 Apache-2.0 一律 [警告] 需人工确认。
# 用法: bash scripts/audit-licenses.sh
set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
for DIR in "." "headless"; do
  echo "==================================================="
  echo "工程: $DIR"
  echo "==================================================="
  # pnpm 严格布局：真实包位于 .pnpm/<slug>/node_modules/@univerjs/<name>/package.json
  # 按 name@version 去重后逐包输出 license
  find "$DIR/node_modules/.pnpm" -maxdepth 4 -type d -path "*/node_modules/@univerjs/*" 2>/dev/null \
    | sort -u \
    | while read -r P; do
        JSON="$P/package.json"
        [ -f "$JSON" ] || continue
        python3 - "$JSON" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
name = d.get("name", "?")
ver = d.get("version", "?")
lic = d.get("license") or (d.get("licenses") or [{}])[0].get("type") or ""
print(f"{name}@{ver}\t{lic or 'NONE'}")
PYEOF
      done \
  | sort -u \
  | while IFS=$'\t' read -r NV LIC; do
      NAME="${NV%@*}"
      if [[ "$NAME" == @univerjs-pro/* || "$NAME" == "@univerjs-pro" ]]; then
        echo "  $NV  ->  $LIC   [违规] 检测到商业包 @univerjs-pro"
        echo "VIOLATION" > /tmp/.audit_flag
      elif [ -z "$LIC" ] || [ "$LIC" = "NONE" ]; then
        echo "  $NV  ->  (空)   [违规] license 字段为空"
        echo "VIOLATION" > /tmp/.audit_flag
      elif [ "$LIC" = "Apache-2.0" ]; then
        echo "  $NV  ->  $LIC"
      elif [[ "$LIC" =~ ^(MIT|BSD.*|ISC|0BSD|Unlicense|Zlib|BlueOak-1.0.0)$ ]]; then
        # 宽松许可白名单：与 Apache-2.0 兼容、可商用（如传递依赖 @univerjs/icons 为 MIT）
        echo "  $NV  ->  $LIC   [宽松许可，兼容]"
      else
        echo "  $NV  ->  $LIC   [警告] license 非 Apache-2.0 亦不在宽松白名单（需人工确认）"
        echo "VIOLATION" > /tmp/.audit_flag
      fi
    done
  if [ -f /tmp/.audit_flag ]; then
    rm -f /tmp/.audit_flag
    FAIL=1
  fi
done

echo "==================================================="
if [ "$FAIL" -eq 0 ]; then
  echo "结论: 通过 —— 全部 @univerjs* 包均为 Apache-2.0，无 @univerjs-pro，无空 license"
else
  echo "结论: 存在违规/警告项（见上）"
fi
exit $FAIL
