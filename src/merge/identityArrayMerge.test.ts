import { describe, expect, it } from 'vitest';
import {
  buildIdentityMergedArray,
  buildIdentityPreviewArray,
  isIdentityMergeEligible,
  pendingAdjudications,
  planIdentityMerge,
  summarizePlan,
  validateIdentityArrays,
  type AdjudicationChoices,
} from './identityArrayMerge';
import { threeWayMerge, type Conflict } from './threeWayMerge';
import { ABSENT, type JsonValue } from './types';

const arr = (s: string) => JSON.parse(s) as JsonValue[];

function planOf(field: string, base: JsonValue[], ours: JsonValue[], theirs: JsonValue[]) {
  expect(validateIdentityArrays(field, base, ours, theirs)).toEqual([]);
  return planIdentityMerge(field, base, ours, theirs);
}

describe('isIdentityMergeEligible', () => {
  const conflictAtRoot = (base: JsonValue, ours: JsonValue, theirs: JsonValue): Conflict =>
    threeWayMerge(base, ours, theirs).conflicts[0];

  it('三方均为数组时可进入', () => {
    const c = conflictAtRoot([1], [2], [3]);
    expect(c).toBeDefined();
    expect(isIdentityMergeEligible(c)).toBe(true);
  });

  it('任一侧缺失或非数组时不可进入', () => {
    // 基线为标量、两侧为数组
    expect(isIdentityMergeEligible(conflictAtRoot(1, [2], [3]))).toBe(false);
    // 一侧删除另一侧修改为数组
    const c = conflictAtRoot({ a: [1] }, {}, { a: [2] });
    expect(isIdentityMergeEligible(c)).toBe(false);
    // 一侧为对象（非数组）
    expect(isIdentityMergeEligible(conflictAtRoot([], {}, [1]))).toBe(false);
  });
});

describe('validateIdentityArrays', () => {
  it('全部合格时无问题', () => {
    const issues = validateIdentityArrays(
      'id',
      arr('[{"id":1},{"id":"a"}]'),
      arr('[{"id":1}]'),
      arr('[{"id":"a"},{"id":2}]'),
    );
    expect(issues).toEqual([]);
  });

  it('项不是对象 / 缺少身份字段 / 身份类型非法时指出侧别与项位置', () => {
    const issues = validateIdentityArrays(
      'id',
      arr('[{"id":1},42]'),
      arr('[{"name":"x"}]'),
      arr('[{"id":true},{"id":{"x":1}},{"id":null}]'),
    );
    expect(issues.map((i) => [i.side, i.index])).toEqual([
      ['base', 1],
      ['ours', 0],
      ['theirs', 0],
      ['theirs', 1],
      ['theirs', 2],
    ]);
    expect(issues[0].message).toContain('基线第 2 项不是对象');
    expect(issues[1].message).toContain('当前分支第 1 项缺少身份字段 "id"');
    expect(issues[2].message).toContain('目标分支第 1 项的身份字段 "id" 必须是字符串或数字');
  });

  it('同侧身份重复时报出两侧位置，跨侧相同不算重复', () => {
    const issues = validateIdentityArrays(
      'id',
      arr('[{"id":"a"},{"id":"a"}]'),
      arr('[{"id":"a"}]'),
      arr('[{"id":"a"},{"id":1},{"id":1}]'),
    );
    expect(issues).toHaveLength(2);
    expect(issues[0].message).toContain('基线身份 字符串 "a" 重复：第 1 项与第 2 项');
    expect(issues[1].message).toContain('目标分支身份 数字 1 重复：第 2 项与第 3 项');
  });

  it('数字 1 与字符串 "1" 是不同身份，不构成重复', () => {
    const issues = validateIdentityArrays(
      'id',
      arr('[{"id":1},{"id":"1"}]'),
      arr('[{"id":1},{"id":"1"}]'),
      arr('[{"id":1},{"id":"1"}]'),
    );
    expect(issues).toEqual([]);
  });
});

describe('planIdentityMerge + buildIdentityMergedArray', () => {
  it('仅一侧修改的记录自动合并，存活基线项保持原顺序', () => {
    const plan = planOf(
      'id',
      arr('[{"id":"a","v":1},{"id":"b","v":2},{"id":"c","v":3}]'),
      arr('[{"id":"a","v":10},{"id":"b","v":2},{"id":"c","v":3}]'),
      arr('[{"id":"a","v":1},{"id":"b","v":2},{"id":"c","v":30}]'),
    );
    expect(plan.adjudications).toEqual([]);
    expect(buildIdentityMergedArray(plan, {})).toEqual(
      arr('[{"id":"a","v":10},{"id":"b","v":2},{"id":"c","v":30}]'),
    );
  });

  it('一侧删项另一侧未改 → 该项删除；双方都删 → 删除', () => {
    const plan = planOf(
      'id',
      arr('[{"id":"a"},{"id":"b"},{"id":"c"}]'),
      arr('[{"id":"b"}]'),
      arr('[{"id":"b"},{"id":"c"}]'),
    );
    expect(plan.adjudications).toEqual([]);
    // a：当前删、目标未改 → 删；c：当前删、目标未改 → 删；b：三方一致保留
    expect(buildIdentityMergedArray(plan, {})).toEqual(arr('[{"id":"b"}]'));
  });

  it('新身份按当前侧再目标侧首次出现顺序追加，不采纳重排', () => {
    const plan = planOf(
      'id',
      arr('[{"id":"a","v":1},{"id":"b","v":2}]'),
      // 当前侧重排了基线项并新增 n1、n2
      arr('[{"id":"b","v":2},{"id":"n1","v":9},{"id":"a","v":1},{"id":"n2","v":8}]'),
      // 目标侧也重排并新增 n3（与 n1 交错出现）
      arr('[{"id":"b","v":2},{"id":"n3","v":7},{"id":"a","v":1},{"id":"n1","v":9}]'),
    );
    expect(plan.adjudications).toEqual([]);
    // 基线项 a、b 保持基线顺序（不采纳任何一侧的重排）；新身份先当前侧 n1、n2，再目标侧 n3
    expect(buildIdentityMergedArray(plan, {})).toEqual(
      arr(
        '[{"id":"a","v":1},{"id":"b","v":2},{"id":"n1","v":9},{"id":"n2","v":8},{"id":"n3","v":7}]',
      ),
    );
    const summary = summarizePlan(plan);
    expect(summary).toMatchObject({ total: 5, baseCount: 2, oursNewCount: 2, theirsNewCount: 1 });
  });

  it('数字 1 与字符串 "1" 对齐为两条不同记录', () => {
    const plan = planOf(
      'id',
      arr('[{"id":1,"v":"n"},{"id":"1","v":"s"}]'),
      arr('[{"id":1,"v":"n2"},{"id":"1","v":"s"}]'),
      arr('[{"id":1,"v":"n"},{"id":"1","v":"s2"}]'),
    );
    expect(plan.entries.map((e) => e.identity)).toEqual([1, '1']);
    expect(buildIdentityMergedArray(plan, {})).toEqual(
      arr('[{"id":1,"v":"n2"},{"id":"1","v":"s2"}]'),
    );
  });

  it('双方同字段异改 → 逐项裁决，未裁决完不可构建', () => {
    const plan = planOf(
      'id',
      arr('[{"id":"a","v":1}]'),
      arr('[{"id":"a","v":2}]'),
      arr('[{"id":"a","v":3}]'),
    );
    expect(plan.adjudications).toHaveLength(1);
    const adj = plan.adjudications[0];
    expect(adj).toMatchObject({ kind: 'field', identity: 'a', path: ['v'], ours: 2, theirs: 3 });
    expect(adj.reason).toContain('双方');

    expect(buildIdentityMergedArray(plan, {})).toBeUndefined();
    expect(pendingAdjudications(plan, {})).toHaveLength(1);

    const ours: AdjudicationChoices = { [adj.id]: 'ours' };
    expect(buildIdentityMergedArray(plan, ours)).toEqual(arr('[{"id":"a","v":2}]'));
    const theirs: AdjudicationChoices = { [adj.id]: 'theirs' };
    expect(buildIdentityMergedArray(plan, theirs)).toEqual(arr('[{"id":"a","v":3}]'));
  });

  it('一侧删项另一侧修改 → 整项裁决：采用删除侧则移除，采用修改侧则保留修改值', () => {
    const plan = planOf(
      'id',
      arr('[{"id":"a","v":1},{"id":"b","v":2}]'),
      arr('[{"id":"b","v":2}]'),
      arr('[{"id":"a","v":10},{"id":"b","v":2}]'),
    );
    expect(plan.adjudications).toHaveLength(1);
    const adj = plan.adjudications[0];
    expect(adj.kind).toBe('item');
    expect(adj.identity).toBe('a');
    expect(adj.ours).toBe(ABSENT); // 当前分支删除了该项
    expect(adj.reason).toContain('当前分支删除了该项');

    expect(buildIdentityMergedArray(plan, { [adj.id]: 'ours' })).toEqual(arr('[{"id":"b","v":2}]'));
    expect(buildIdentityMergedArray(plan, { [adj.id]: 'theirs' })).toEqual(
      arr('[{"id":"a","v":10},{"id":"b","v":2}]'),
    );
  });

  it('删除与 null 有别：字段被删除 vs 被置 null 属于双方异改，需裁决', () => {
    const plan = planOf(
      'id',
      arr('[{"id":"a","v":1}]'),
      arr('[{"id":"a","v":null}]'),
      arr('[{"id":"a"}]'),
    );
    expect(plan.adjudications).toHaveLength(1);
    const adj = plan.adjudications[0];
    expect(adj.kind).toBe('field');
    expect(adj.ours).toBeNull();
    expect(adj.reason).toContain('目标分支删除了该字段');

    expect(buildIdentityMergedArray(plan, { [adj.id]: 'ours' })).toEqual(
      arr('[{"id":"a","v":null}]'),
    );
    expect(buildIdentityMergedArray(plan, { [adj.id]: 'theirs' })).toEqual(arr('[{"id":"a"}]'));
  });

  it('嵌套对象按键递归合并，嵌套数组仍整体比较', () => {
    const plan = planOf(
      'id',
      arr('[{"id":"a","cfg":{"x":1,"y":2},"tags":["a","b"]}]'),
      arr('[{"id":"a","cfg":{"x":10,"y":2},"tags":["a"]}]'),
      arr('[{"id":"a","cfg":{"x":1,"y":20},"tags":["b"]}]'),
    );
    // cfg.x / cfg.y 各只被一侧修改 → 自动合并；tags 双方改成不同数组 → 整体裁决
    expect(plan.adjudications).toHaveLength(1);
    const adj = plan.adjudications[0];
    expect(adj).toMatchObject({ kind: 'field', path: ['tags'] });
    expect(adj.ours).toEqual(['a']);
    expect(adj.theirs).toEqual(['b']);

    expect(buildIdentityMergedArray(plan, { [adj.id]: 'theirs' })).toEqual(
      arr('[{"id":"a","cfg":{"x":10,"y":20},"tags":["b"]}]'),
    );
  });

  it('双方新增同一身份但内容不同 → 按键递归，异改字段逐项裁决', () => {
    const plan = planOf(
      'id',
      arr('[]'),
      arr('[{"id":"n","a":1,"b":1}]'),
      arr('[{"id":"n","a":1,"b":2}]'),
    );
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].origin).toBe('ours-new');
    expect(plan.adjudications).toHaveLength(1);
    expect(plan.adjudications[0]).toMatchObject({ kind: 'field', path: ['b'] });
    expect(buildIdentityMergedArray(plan, { [plan.adjudications[0].id]: 'ours' })).toEqual(
      arr('[{"id":"n","a":1,"b":1}]'),
    );
  });

  it('一侧删字段另一侧未改 → 自动采用删除；字段级双方异改含删除时逐项裁决', () => {
    const plan = planOf(
      'id',
      arr('[{"id":"a","drop":1,"keep":2}]'),
      arr('[{"id":"a","keep":2}]'),
      arr('[{"id":"a","drop":1,"keep":2}]'),
    );
    expect(plan.adjudications).toEqual([]);
    expect(buildIdentityMergedArray(plan, {})).toEqual(arr('[{"id":"a","keep":2}]'));
  });

  it('候选数组预览：未裁决处以占位标出，裁决完成后与最终结果一致', () => {
    const plan = planOf(
      'id',
      arr('[{"id":"a","v":1},{"id":"b","v":2}]'),
      arr('[{"id":"a","v":2},{"id":"b","v":2}]'),
      arr('[{"id":"a","v":3},{"id":"b","v":9}]'),
    );
    const adj = plan.adjudications[0];
    const preview0 = buildIdentityPreviewArray(plan, {});
    expect(JSON.stringify(preview0[0])).toContain('⟪待裁决：字符串 \\"a\\" · 字段 /v⟫');
    expect(preview0[1]).toEqual({ id: 'b', v: 9 });

    const choices: AdjudicationChoices = { [adj.id]: 'theirs' };
    const preview1 = buildIdentityPreviewArray(plan, choices);
    expect(preview1).toEqual(buildIdentityMergedArray(plan, choices));
    expect(JSON.stringify(preview1)).not.toContain('⟪');
  });

  it('整项去留未裁决时预览以占位元素标出', () => {
    const plan = planOf(
      'id',
      arr('[{"id":"a","v":1}]'),
      arr('[]'),
      arr('[{"id":"a","v":2}]'),
    );
    const preview = buildIdentityPreviewArray(plan, {});
    expect(preview).toHaveLength(1);
    expect(String(preview[0])).toContain('⟪待裁决：字符串 "a" · 整项去留⟫');
  });
});
