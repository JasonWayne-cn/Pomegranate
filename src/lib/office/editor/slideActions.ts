/** 幻灯片结构操作的下标计算（纯函数，便于单测）。 */

export type SlideMoveDirection = -1 | 1;

/** 上移/下移的目标下标；越界返回 null。 */
export function moveTarget(
  index: number,
  pageCount: number,
  direction: SlideMoveDirection,
): number | null {
  const to = index + direction;
  if (to < 0 || to >= pageCount) return null;
  return to;
}

/** 删除某一页后应该激活的下标（删除的是最后一页时回退一页）。 */
export function activeAfterDelete(index: number, pageCount: number): number {
  if (pageCount <= 1) return 0;
  return Math.max(0, Math.min(index, pageCount - 2));
}

/** 新建/复制页之后激活的下标（插入到当前页之后）。 */
export function activeAfterInsert(index: number, pageCount: number): number {
  return Math.min(index + 1, pageCount);
}

/** Tab 在元素之间循环。 */
export function cycleIndex(current: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}
