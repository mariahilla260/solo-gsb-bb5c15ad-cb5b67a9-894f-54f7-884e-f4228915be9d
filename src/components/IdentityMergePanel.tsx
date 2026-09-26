import { useMemo } from 'react';
import type { Conflict } from '../merge/threeWayMerge';
import {
  buildIdentityMergedArray,
  buildIdentityPreviewArray,
  identityLabel,
  pendingAdjudications,
  planIdentityMerge,
  summarizePlan,
  validateIdentityArrays,
  type AdjudicationChoice,
} from '../merge/identityArrayMerge';
import { toPointer } from '../merge/pointer';
import { isAbsent, type JsonValue, type SideValue } from '../merge/types';

/**
 * 「按身份字段合并」草稿：身份字段名 + 逐项裁决选择。
 * 仅作为面板内的未提交进度保存；提交后写入正式 resolutions（自定义值）。
 */
export interface IdentityMergeDraft {
  /** 身份字段名（原始输入） */
  field: string;
  /** 裁决 id -> 采用侧 */
  choices: Record<string, AdjudicationChoice>;
  /** 草稿对应的冲突三方值签名，防止切换到另一组合并/另一冲突后误用旧选择 */
  signature: string;
}

export function emptyIdentityDraft(signature: string): IdentityMergeDraft {
  return { field: '', choices: {}, signature };
}

interface Props {
  conflict: Conflict;
  draft: IdentityMergeDraft;
  onDraftChange: (draft: IdentityMergeDraft) => void;
  /** 裁决全部完成后一次提交：作为原数组冲突的自定义值 */
  onSubmit: (value: JsonValue) => void;
}

function SideMini({ label, value }: { label: string; value: SideValue }) {
  return (
    <div className="identity-side">
      <h5>{label}</h5>
      <pre>{isAbsent(value) ? '（此侧已删除）' : JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

export default function IdentityMergePanel({ conflict, draft, onDraftChange, onSubmit }: Props) {
  const field = draft.field.trim();

  // 身份字段变化时重新解析：先校验（不合格即列出侧别与项位置），再生成合并计划
  const analysis = useMemo(() => {
    if (!field) return null;
    const base = conflict.base as JsonValue[];
    const ours = conflict.ours as JsonValue[];
    const theirs = conflict.theirs as JsonValue[];
    const issues = validateIdentityArrays(field, base, ours, theirs);
    if (issues.length > 0) return { issues } as const;
    return { plan: planIdentityMerge(field, base, ours, theirs) } as const;
  }, [conflict, field]);

  const plan = analysis && 'plan' in analysis ? analysis.plan : null;
  const issues = analysis && 'issues' in analysis ? analysis.issues : null;

  const pending = plan ? pendingAdjudications(plan, draft.choices) : [];
  const preview = plan ? buildIdentityPreviewArray(plan, draft.choices) : null;
  const summary = plan ? summarizePlan(plan) : null;

  const choose = (id: string, choice: AdjudicationChoice) => {
    onDraftChange({ ...draft, choices: { ...draft.choices, [id]: choice } });
  };

  const submit = () => {
    if (!plan) return;
    const value = buildIdentityMergedArray(plan, draft.choices);
    if (value === undefined) return; // 仍有未裁决项，禁止提交
    onSubmit(value);
  };

  return (
    <div className="identity-merge">
      <div className="identity-head">
        <h4>按身份字段合并</h4>
        <span className="hint">三方均为对象数组：按顶层身份字段对齐记录，逐项复用对象合并规则</span>
      </div>
      <label className="identity-field-row">
        <span>身份字段名</span>
        <input
          className="identity-field-input"
          type="text"
          placeholder='顶层字段名，例如 "id"'
          value={draft.field}
          onChange={(e) => onDraftChange({ ...draft, field: e.target.value, choices: {} })}
          spellCheck={false}
        />
      </label>
      {!field && (
        <div className="identity-hint">
          填写身份字段名后自动解析三方数组：每项必须具有字符串或数字身份，同侧身份不得重复（数字 1
          与字符串 "1" 视为不同身份）。
        </div>
      )}
      {issues && (
        <div className="identity-issues">
          <div className="identity-issues-title">✕ 身份校验未通过，已禁止提交：</div>
          <ul>
            {issues.map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}
      {plan && summary && (
        <>
          <div className="identity-summary">
            按身份对齐 <strong>{summary.total}</strong> 条记录（基线 {summary.baseCount} · 当前新增{' '}
            {summary.oursNewCount} · 目标新增 {summary.theirsNewCount}），
            {plan.adjudications.length === 0 ? (
              <>全部自动合并，可直接提交。</>
            ) : (
              <>
                待裁决 <strong>{plan.adjudications.length}</strong> 处（剩余 {pending.length} 处）。
              </>
            )}
          </div>
          {plan.adjudications.length > 0 && (
            <div className="identity-adjudications">
              {plan.adjudications.map((adj) => {
                const choice = draft.choices[adj.id];
                return (
                  <div
                    className={`identity-adj${choice ? ' resolved' : ''}`}
                    key={adj.id}
                  >
                    <div className="identity-adj-head">
                      <span className="identity-adj-title">
                        {identityLabel(adj.identity)}
                        {adj.kind === 'item' ? ' · 整项去留' : ` · 字段 ${toPointer(adj.path)}`}
                      </span>
                      <span className="identity-adj-reason">{adj.reason}</span>
                    </div>
                    <div className="identity-adj-values">
                      <SideMini label="当前分支" value={adj.ours} />
                      <SideMini label="目标分支" value={adj.theirs} />
                    </div>
                    <div className="identity-adj-actions">
                      <button
                        className={`small ours-btn${choice === 'ours' ? ' active-choice' : ''}`}
                        onClick={() => choose(adj.id, 'ours')}
                      >
                        采用当前
                      </button>
                      <button
                        className={`small theirs-btn${choice === 'theirs' ? ' active-choice' : ''}`}
                        onClick={() => choose(adj.id, 'theirs')}
                      >
                        采用目标
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="identity-preview">
            <h5>
              候选数组
              {pending.length > 0
                ? `（${pending.length} 处待裁决，以 ⟪⟫ 占位）`
                : '（裁决完成，可提交）'}
            </h5>
            <pre>{JSON.stringify(preview, null, 2)}</pre>
          </div>
          <button
            className="primary identity-submit"
            disabled={pending.length > 0}
            title={
              pending.length > 0
                ? `还有 ${pending.length} 处待裁决，全部完成后才能提交`
                : '将候选数组作为本冲突的自定义值提交'
            }
            onClick={submit}
          >
            {pending.length > 0
              ? `还有 ${pending.length} 处待裁决`
              : '提交为自定义值（解决本冲突）'}
          </button>
        </>
      )}
    </div>
  );
}
