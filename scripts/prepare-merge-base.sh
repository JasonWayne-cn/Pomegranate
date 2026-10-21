#!/usr/bin/env bash
# 导出 KB v1.8.0 基线快照，供 scripts/merge-three-way.sh 使用
# 用法：scripts/prepare-merge-base.sh
set -euo pipefail

KB_REPO="${KB_REPO:-D:/AI/W-Pomegranate-knowledge-base}"
BASE="${KB_BASE:-/tmp/kb-v180}"
TAG="${KB_BASELINE_TAG:-v1.8.0}"

rm -rf "$BASE"
mkdir -p "$BASE"
git -C "$KB_REPO" archive "$TAG" | tar -x -C "$BASE"

COUNT="$(find "$BASE" -type f | wc -l | tr -d ' ')"
echo "已导出 $TAG -> $BASE（$COUNT 个文件）"
