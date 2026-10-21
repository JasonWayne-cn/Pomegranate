#!/usr/bin/env bash
# 三方合并单个文件：ours(Pomegranate) / base(KB v1.8.0) / theirs(KB 2.0)
# 用法：scripts/merge-three-way.sh src/pages/home/index.tsx
# 输出：<原路径>.merged（不覆盖原文件，人工审查后再决定是否替换）
set -euo pipefail

REL="${1:?用法: scripts/merge-three-way.sh <相对路径>}"
BASE="${KB_BASE:-/tmp/kb-v180}"
OURS="${OURS_ROOT:-$(pwd)}"
THEIRS="${KB_THEIRS:-D:/AI/W-Pomegranate-knowledge-base}"

if [ ! -f "$OURS/$REL" ]; then
  echo "ours 不存在: $OURS/$REL" >&2
  exit 2
fi
if [ ! -f "$BASE/$REL" ]; then
  echo "base 不存在（该文件可能是升级版新增）: $BASE/$REL" >&2
  exit 3
fi
if [ ! -f "$THEIRS/$REL" ]; then
  echo "theirs 不存在: $THEIRS/$REL" >&2
  exit 4
fi

TMP="$(mktemp)"
cp "$OURS/$REL" "$TMP"

set +e
git merge-file --diff3 \
  -L "ours(Pomegranate)" \
  -L "base(KB v1.8.0)" \
  -L "theirs(KB 2.0)" \
  "$TMP" "$BASE/$REL" "$THEIRS/$REL"
CODE=$?
set -e

OUT="$OURS/$REL.merged"
mv "$TMP" "$OUT"

if [ "$CODE" -eq 0 ]; then
  echo "OK: 无冲突 -> $OUT"
else
  echo "CONFLICT[$CODE]: 冲突块数量 -> $OUT"
fi
exit "$CODE"
