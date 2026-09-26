// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import MergeStage from './MergeStage';
import { threeWayMerge, type Resolutions } from '../merge/threeWayMerge';
import {
  initHistory,
  resolutionHistoryReducer,
  type HistoryTransaction,
  type ResolutionHistoryState,
  type TransactionKind,
} from '../merge/history';
import type { JsonValue } from '../merge/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 未实现 scrollIntoView（合并树定位冲突时会调用）
Element.prototype.scrollIntoView = function scrollIntoView() {};

function makeRenderer(container: HTMLElement) {
  const root = createRoot(container);
  return (node: ReactElement) => act(() => root.render(node));
}

const h = (container: HTMLElement | Element | null, sel: string) =>
  container ? container.querySelector(sel) : null;
const all = (container: HTMLElement | Element | null, sel: string) =>
  container ? [...container.querySelectorAll(sel)] : [];
const btnByText = (container: HTMLElement | Element | null, text: string) =>
  all(container, 'button').find((b) => b.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;

/** React 受控组件需要用原生 setter 赋值后再派发 input 事件 */
function typeInto(input: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, v);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// 数组冲突场景：a 双方异改 v；b 当前删、目标改；n 仅当前新增
const BASE: JsonValue = { list: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }] };
const OURS: JsonValue = { list: [{ id: 'a', v: 10 }, { id: 'n', v: 9 }] };
const THEIRS: JsonValue = { list: [{ id: 'a', v: 20 }, { id: 'b', v: 30 }] };

function setup(docs: { base: JsonValue; ours: JsonValue; theirs: JsonValue } = {
  base: BASE,
  ours: OURS,
  theirs: THEIRS,
}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const mergeResult = threeWayMerge(docs.base, docs.ours, docs.theirs);

  let history: ResolutionHistoryState = initHistory({});
  const render = makeRenderer(container);
  const rerender = () => {
    const canUndo = history.past.length > 0;
    const canRedo = history.future.length > 0;
    render(
      <MergeStage
        mergeResult={mergeResult}
        resolutions={history.present}
        onCommit={(kind: TransactionKind, next: Resolutions): HistoryTransaction | null => {
          const prevLength = history.past.length;
          history = resolutionHistoryReducer(history, { type: 'commit', kind, next });
          rerender();
          return history.past.length > prevLength ? history.past[history.past.length - 1] : null;
        }}
        onUndo={() => {
          const tx = history.past[history.past.length - 1] ?? null;
          history = resolutionHistoryReducer(history, { type: 'undo' });
          rerender();
          return tx;
        }}
        onRedo={() => {
          const tx = history.future[0] ?? null;
          history = resolutionHistoryReducer(history, { type: 'redo' });
          rerender();
          return tx;
        }}
        canUndo={canUndo}
        canRedo={canRedo}
        undoTransaction={canUndo ? history.past[history.past.length - 1] : null}
        redoTransaction={canRedo ? history.future[0] : null}
        onFinish={() => {}}
        onBack={() => {}}
        restoreInfo={null}
      />,
    );
  };
  rerender();
  return { container, mergeResult, getResolutions: () => history.present };
}

const identityPanel = (container: HTMLElement) => h(container, '.identity-merge');
const fieldInput = (container: HTMLElement) =>
  h(container, '.identity-field-input') as HTMLInputElement | null;
const submitBtn = (container: HTMLElement) =>
  h(container, '.identity-submit') as HTMLButtonElement | null;

describe('IdentityMergePanel 按身份字段合并', () => {
  it('仅当冲突三方均为数组时出现', () => {
    const { container } = setup();
    expect(identityPanel(container)).not.toBeNull();

    const scalar = setup({ base: { v: 1 }, ours: { v: 2 }, theirs: { v: 3 } });
    expect(identityPanel(scalar.container)).toBeNull();
  });

  it('身份校验不合格时指出侧别与项位置，且不出现提交入口', () => {
    const { container } = setup();
    act(() => typeInto(fieldInput(container)!, 'uid'));

    const issues = h(container, '.identity-issues');
    expect(issues).not.toBeNull();
    // 三方均缺少 uid：每侧逐项报错
    expect(issues!.textContent).toContain('基线第 1 项缺少身份字段 "uid"');
    expect(issues!.textContent).toContain('当前分支第 2 项缺少身份字段 "uid"');
    expect(issues!.textContent).toContain('目标分支第 1 项缺少身份字段 "uid"');
    // 校验未通过：没有候选数组与提交按钮，禁止提交
    expect(submitBtn(container)).toBeNull();
    expect(h(container, '.identity-preview')).toBeNull();
  });

  it('同侧身份重复时报错并禁止提交', () => {
    const { container } = setup({
      base: { list: [{ id: 'a' }, { id: 'a' }] },
      ours: { list: [{ id: 'a' }, { id: 'a' }, { id: 'x' }] },
      theirs: { list: [{ id: 'a' }, { id: 'a' }, { id: 'y' }] },
    });
    act(() => typeInto(fieldInput(container)!, 'id'));
    const issues = h(container, '.identity-issues');
    expect(issues!.textContent).toContain('基线身份 字符串 "a" 重复：第 1 项与第 2 项');
    expect(submitBtn(container)).toBeNull();
  });

  it('逐项裁决后一次提交为自定义值，并接入撤销', () => {
    const { container, mergeResult, getResolutions } = setup();
    const conflictId = mergeResult.conflicts[0].id;

    act(() => typeInto(fieldInput(container)!, 'id'));

    // 概览：3 条身份（基线 2 · 当前新增 1），2 处待裁决；提交按钮禁用
    expect(h(container, '.identity-summary')?.textContent).toContain('3');
    expect(h(container, '.identity-summary')?.textContent).toContain('待裁决 2');
    expect(submitBtn(container)!.disabled).toBe(true);

    // 两条裁决：a 的字段 /v 双方异改；b 整项去留（当前删、目标改）
    const adjs = all(container, '.identity-adj');
    expect(adjs).toHaveLength(2);
    expect(adjs[0].textContent).toContain('字符串 "a"');
    expect(adjs[0].textContent).toContain('字段 /v');
    expect(adjs[1].textContent).toContain('整项去留');
    expect(adjs[1].textContent).toContain('当前分支删除了该项');

    // 候选数组预览含占位标记
    expect(h(container, '.identity-preview pre')?.textContent).toContain('⟪待裁决');

    // 逐项选择：a.v 采用目标（20），b 采用目标（保留修改后的项）
    act(() => btnByText(adjs[0], '采用目标')!.click());
    expect(submitBtn(container)!.disabled).toBe(true); // 仍有 1 处待裁决
    act(() => btnByText(adjs[1], '采用目标')!.click());
    expect(submitBtn(container)!.disabled).toBe(false);

    // 裁决完成后预览不再含占位，且与最终结果一致
    expect(h(container, '.identity-preview pre')?.textContent).not.toContain('⟪待裁决');

    act(() => submitBtn(container)!.click());

    // 一次提交为原数组冲突的自定义值：基线项保持原顺序，新身份 n 追加在末尾
    expect(getResolutions()[conflictId]).toEqual({
      kind: 'custom',
      value: [{ id: 'a', v: 20 }, { id: 'b', v: 30 }, { id: 'n', v: 9 }],
    });

    // 接入现有撤销：撤销后回到未选择状态
    act(() => btnByText(container, '↩ 撤销')!.click());
    expect(getResolutions()[conflictId]).toBeUndefined();
    // 重做恢复
    act(() => btnByText(container, '↪ 重做')!.click());
    expect(getResolutions()[conflictId]).toEqual({
      kind: 'custom',
      value: [{ id: 'a', v: 20 }, { id: 'b', v: 30 }, { id: 'n', v: 9 }],
    });
  });

  it('整项去留采用删除侧时该项从结果中移除', () => {
    const { container, mergeResult, getResolutions } = setup();
    const conflictId = mergeResult.conflicts[0].id;

    act(() => typeInto(fieldInput(container)!, 'id'));
    const adjs = all(container, '.identity-adj');
    act(() => btnByText(adjs[0], '采用当前')!.click()); // a.v = 10
    act(() => btnByText(adjs[1], '采用当前')!.click()); // b 删除
    act(() => submitBtn(container)!.click());

    expect(getResolutions()[conflictId]).toEqual({
      kind: 'custom',
      value: [{ id: 'a', v: 10 }, { id: 'n', v: 9 }],
    });
  });

  it('无待裁决时可直接提交（全部自动合并）', () => {
    const { container, mergeResult, getResolutions } = setup({
      base: { list: [{ id: 'a', v: 1 }] },
      ours: { list: [{ id: 'a', v: 2 }] },
      theirs: { list: [{ id: 'a', v: 1 }, { id: 'n', v: 5 }] },
    });
    const conflictId = mergeResult.conflicts[0].id;

    act(() => typeInto(fieldInput(container)!, 'id'));
    expect(all(container, '.identity-adj')).toHaveLength(0);
    expect(submitBtn(container)!.disabled).toBe(false);

    act(() => submitBtn(container)!.click());
    expect(getResolutions()[conflictId]).toEqual({
      kind: 'custom',
      value: [{ id: 'a', v: 2 }, { id: 'n', v: 5 }],
    });
  });
});
