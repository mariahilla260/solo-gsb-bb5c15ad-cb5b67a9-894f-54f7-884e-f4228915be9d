import { deepEqual } from './deepEqual';
import { toPointer } from './pointer';
import type { Conflict } from './threeWayMerge';
import { ABSENT, isAbsent, isPlainObject, type JsonValue, type SideValue } from './types';

/**
 * 按身份字段合并对象数组：
 * 三方均为对象数组的冲突，可指定一个顶层身份字段，把三侧记录按身份对齐后
 * 复用对象三方合并规则逐项合并（嵌套数组仍按整体值比较），
 * 结果作为原数组冲突的自定义值一次提交。
 */

export type IdentitySide = 'base' | 'ours' | 'theirs';

export const SIDE_LABELS: Record<IdentitySide, string> = {
  base: '基线',
  ours: '当前分支',
  theirs: '目标分支',
};

/** 合法身份值：字符串或数字；数字 1 与字符串 "1" 是不同身份 */
export type IdentityValue = string | number;

/** 身份键：带类型前缀，保证数字 1 与字符串 "1" 区分开 */
function identityKey(value: IdentityValue): string {
  return `${typeof value === 'number' ? 'n' : 's'}:${String(value)}`;
}

/** 展示用身份标签：明确区分数字与字符串 */
export function identityLabel(value: IdentityValue): string {
  return typeof value === 'number' ? `数字 ${JSON.stringify(value)}` : `字符串 ${JSON.stringify(value)}`;
}

/** 身份校验问题：指出侧别与项位置（index 从 0 起，message 已含 1 起的人类可读位置） */
export interface IdentityIssue {
  side: IdentitySide;
  index: number;
  message: string;
}

/** 冲突是否可进入「按身份字段合并」：三方均为数组（项级校验在填写身份字段后进行） */
export function isIdentityMergeEligible(conflict: Conflict): boolean {
  return (
    !isAbsent(conflict.base) &&
    Array.isArray(conflict.base) &&
    !isAbsent(conflict.ours) &&
    Array.isArray(conflict.ours) &&
    !isAbsent(conflict.theirs) &&
    Array.isArray(conflict.theirs)
  );
}

/**
 * 校验三方数组是否可按给定身份字段合并：
 * - 每项必须是对象，且具有该顶层字段；
 * - 身份值必须是字符串或数字；
 * - 同一侧内身份不得重复（跨侧相同身份正是对齐依据，不算重复）。
 * 任一不合格即返回全部问题（指出侧别与项位置），调用方应禁止提交。
 */
export function validateIdentityArrays(
  field: string,
  base: JsonValue[],
  ours: JsonValue[],
  theirs: JsonValue[],
): IdentityIssue[] {
  const issues: IdentityIssue[] = [];
  const sides: Record<IdentitySide, JsonValue[]> = { base, ours, theirs };
  for (const side of ['base', 'ours', 'theirs'] as const) {
    const label = SIDE_LABELS[side];
    /** 身份键 -> 首次出现的项下标（0 起） */
    const seen = new Map<string, number>();
    sides[side].forEach((item, index) => {
      const pos = `第 ${index + 1} 项`;
      if (!isPlainObject(item)) {
        issues.push({ side, index, message: `${label}${pos}不是对象，无法读取身份字段` });
        return;
      }
      if (!(field in item)) {
        issues.push({ side, index, message: `${label}${pos}缺少身份字段 "${field}"` });
        return;
      }
      const value = item[field];
      if (typeof value !== 'string' && typeof value !== 'number') {
        issues.push({
          side,
          index,
          message: `${label}${pos}的身份字段 "${field}" 必须是字符串或数字`,
        });
        return;
      }
      const key = identityKey(value);
      const first = seen.get(key);
      if (first !== undefined) {
        issues.push({
          side,
          index,
          message: `${label}身份 ${identityLabel(value)} 重复：第 ${first + 1} 项与${pos}`,
        });
      } else {
        seen.set(key, index);
      }
    });
  }
  return issues;
}

/** 一条待裁决项：整项去留（一侧删项另一侧修改）或记录内某字段双方异改 */
export interface Adjudication {
  id: string;
  /** 所属记录的身份值 */
  identity: IdentityValue;
  /** item=整项去留；field=记录内字段取值 */
  kind: 'item' | 'field';
  /** kind=field 时字段在记录内的路径段（嵌套对象展开；数组/标量整体） */
  path: string[];
  ours: SideValue;
  theirs: SideValue;
  reason: string;
}

export type AdjudicationChoice = 'ours' | 'theirs';
export type AdjudicationChoices = Record<string, AdjudicationChoice>;

/** 记录合并树的内部节点：已定值 / 待裁决 / 对象容器 */
export type RecordNode =
  | { type: 'value'; value: SideValue }
  | { type: 'pending'; adjudicationId: string }
  | { type: 'object'; children: Array<{ key: string; node: RecordNode }> };

/** 一个身份在结果中的条目（含结果顺序信息） */
export interface IdentityEntry {
  key: string;
  identity: IdentityValue;
  /** base=基线已有（保持原顺序）；ours-new / theirs-new=新身份（依次追加） */
  origin: 'base' | 'ours-new' | 'theirs-new';
  root: RecordNode;
}

export interface IdentityMergePlan {
  field: string;
  /** 按结果顺序排列：存活基线项保持原顺序，新身份先当前侧后目标侧按首次出现追加 */
  entries: IdentityEntry[];
  adjudications: Adjudication[];
}

function adjudicationReason(ours: SideValue, theirs: SideValue, isItem: boolean): string {
  const target = isItem ? '该项' : '该字段';
  if (isAbsent(ours)) return `当前分支删除了${target}，目标分支对${target}有修改`;
  if (isAbsent(theirs)) return `目标分支删除了${target}，当前分支对${target}有修改`;
  return `双方修改了${target}且结果不同`;
}

/**
 * 单条记录（或记录内一个字段）的三方合并，与 threeWayMerge 的对象规则一致：
 * 双方一致 / 仅一侧修改 → 直接采用；双方均为对象 → 按键递归；
 * 其余（一侧删除另一侧修改、双方异改的标量或数组整体）→ 登记为待裁决。
 */
function mergeRecordValue(
  base: SideValue,
  ours: SideValue,
  theirs: SideValue,
  identity: IdentityValue,
  path: string[],
  adjudications: Adjudication[],
): RecordNode {
  if (deepEqual(ours, theirs)) return { type: 'value', value: ours };
  if (deepEqual(base, ours)) return { type: 'value', value: theirs };
  if (deepEqual(base, theirs)) return { type: 'value', value: ours };

  if (isPlainObject(ours) && isPlainObject(theirs)) {
    const baseObj = isPlainObject(base) ? base : {};
    const keys: string[] = [];
    const pushKeys = (obj: Record<string, JsonValue>) => {
      for (const k of Object.keys(obj)) if (!keys.includes(k)) keys.push(k);
    };
    pushKeys(baseObj);
    pushKeys(ours);
    pushKeys(theirs);
    return {
      type: 'object',
      children: keys.map((k) => ({
        key: k,
        node: mergeRecordValue(
          k in baseObj ? baseObj[k] : ABSENT,
          k in ours ? ours[k] : ABSENT,
          k in theirs ? theirs[k] : ABSENT,
          identity,
          [...path, k],
          adjudications,
        ),
      })),
    };
  }

  const id = `a${adjudications.length}`;
  adjudications.push({
    id,
    identity,
    kind: path.length === 0 ? 'item' : 'field',
    path,
    ours,
    theirs,
    reason: adjudicationReason(ours, theirs, path.length === 0),
  });
  return { type: 'pending', adjudicationId: id };
}

/**
 * 按身份字段对齐三方记录并生成合并计划。
 * 调用前须先通过 validateIdentityArrays 校验（每项均为含合法身份的对象且同侧无重复）。
 */
export function planIdentityMerge(
  field: string,
  base: JsonValue[],
  ours: JsonValue[],
  theirs: JsonValue[],
): IdentityMergePlan {
  const identityByKey = new Map<string, IdentityValue>();
  const collect = (arr: JsonValue[]) => {
    const map = new Map<string, JsonValue>();
    const keys: string[] = [];
    for (const item of arr) {
      const identity = (item as Record<string, JsonValue>)[field] as IdentityValue;
      const key = identityKey(identity);
      map.set(key, item);
      keys.push(key);
      if (!identityByKey.has(key)) identityByKey.set(key, identity);
    }
    return { map, keys };
  };
  const b = collect(base);
  const o = collect(ours);
  const t = collect(theirs);

  const adjudications: Adjudication[] = [];
  const entries: IdentityEntry[] = [];
  const seen = new Set<string>();
  const pushEntry = (key: string, origin: IdentityEntry['origin']) => {
    if (seen.has(key)) return;
    seen.add(key);
    const itemOf = (m: Map<string, JsonValue>): SideValue =>
      m.has(key) ? m.get(key)! : ABSENT;
    const identity = identityByKey.get(key)!;
    entries.push({
      key,
      identity,
      origin,
      root: mergeRecordValue(itemOf(b.map), itemOf(o.map), itemOf(t.map), identity, [], adjudications),
    });
  };
  // 结果顺序：基线项保持原顺序；新身份先当前侧、再目标侧，各按首次出现顺序追加（不采纳重排）
  b.keys.forEach((k) => pushEntry(k, 'base'));
  o.keys.forEach((k) => pushEntry(k, 'ours-new'));
  t.keys.forEach((k) => pushEntry(k, 'theirs-new'));

  return { field, entries, adjudications };
}

function adjudicationOf(plan: IdentityMergePlan, id: string): Adjudication {
  const adj = plan.adjudications.find((a) => a.id === id);
  if (!adj) throw new Error(`未知的裁决 id：${id}`);
  return adj;
}

/** 待裁决占位文本（仅用于候选数组预览，不会出现在提交值中） */
function pendingPlaceholder(adj: Adjudication): string {
  const where = adj.kind === 'item' ? '整项去留' : `字段 ${toPointer(adj.path)}`;
  return `⟪待裁决：${identityLabel(adj.identity)} · ${where}⟫`;
}

/**
 * 组装一条记录的合并值。
 * preview=false 时存在未裁决项返回 undefined；preview=true 时未裁决处以占位字符串标出。
 */
function buildRecordValue(
  node: RecordNode,
  plan: IdentityMergePlan,
  choices: AdjudicationChoices,
  preview: boolean,
): SideValue | undefined {
  if (node.type === 'value') return node.value;
  if (node.type === 'pending') {
    const adj = adjudicationOf(plan, node.adjudicationId);
    const choice = choices[adj.id];
    if (choice) return choice === 'ours' ? adj.ours : adj.theirs;
    return preview ? pendingPlaceholder(adj) : undefined;
  }
  const out: Record<string, JsonValue> = {};
  for (const { key, node: child } of node.children) {
    const v = buildRecordValue(child, plan, choices, preview);
    if (v === undefined) return undefined;
    if (!isAbsent(v)) out[key] = v;
  }
  return out;
}

/** 全部裁决完成后的最终数组；存在未裁决项时返回 undefined（调用方应禁止提交） */
export function buildIdentityMergedArray(
  plan: IdentityMergePlan,
  choices: AdjudicationChoices,
): JsonValue[] | undefined {
  const out: JsonValue[] = [];
  for (const entry of plan.entries) {
    const v = buildRecordValue(entry.root, plan, choices, false);
    if (v === undefined) return undefined;
    if (!isAbsent(v)) out.push(v);
  }
  return out;
}

/** 候选数组预览：未裁决处以 ⟪待裁决：…⟫ 占位字符串标出 */
export function buildIdentityPreviewArray(
  plan: IdentityMergePlan,
  choices: AdjudicationChoices,
): JsonValue[] {
  const out: JsonValue[] = [];
  for (const entry of plan.entries) {
    const v = buildRecordValue(entry.root, plan, choices, true);
    if (v !== undefined && !isAbsent(v)) out.push(v);
  }
  return out;
}

/** 尚未做出选择的裁决项 */
export function pendingAdjudications(
  plan: IdentityMergePlan,
  choices: AdjudicationChoices,
): Adjudication[] {
  return plan.adjudications.filter((a) => choices[a.id] === undefined);
}

/** 计划概览：身份总数、各来源数量、含待裁决的记录数 */
export function summarizePlan(plan: IdentityMergePlan): {
  total: number;
  baseCount: number;
  oursNewCount: number;
  theirsNewCount: number;
  pendingEntries: number;
} {
  const pendingKeys = new Set(plan.adjudications.map((a) => identityKey(a.identity)));
  return {
    total: plan.entries.length,
    baseCount: plan.entries.filter((e) => e.origin === 'base').length,
    oursNewCount: plan.entries.filter((e) => e.origin === 'ours-new').length,
    theirsNewCount: plan.entries.filter((e) => e.origin === 'theirs-new').length,
    pendingEntries: plan.entries.filter((e) => pendingKeys.has(e.key)).length,
  };
}
