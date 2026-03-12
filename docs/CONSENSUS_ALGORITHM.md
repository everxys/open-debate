# AI 辩论场 - MVP 共识算法

## 概述

MVP 的共识机制只承担一个职责：在辩论过程中判断是否可以“提前结束”。它不是裁判系统，也不负责复杂观点建模。

---

## 当前版本边界

### V1.0 只做

- 提取 `proposed_solution`
- 记录 `support` / `rebuttal`
- 记录可选 `agreement_score`
- 基于轻量规则判断是否提前结束

### V1.0 不做

- 观点图谱
- 五维度打分
- 用户投票加权
- AI 裁判确认
- 方案融合

---

## AI 输出格式

```typescript
interface AIResponse {
  proposed_solution?: string;
  arguments?: Array<{
    type: 'support' | 'rebuttal';
    content: string;
    target?: string;
  }>;
  agreement_score?: number; // 0-10，可选
}
```

如果解析失败：

- 保留原始文本
- `parse_status = 'fallback'`
- 本轮不参与共识计算，或仅以原始文本做展示

---

## 运行时聚合结构

不要求单独建复杂表，运行时可按当前 debate 的发言记录聚合出：

```typescript
interface SolutionSnapshot {
  name: string;
  supportCount: number;
  rebuttalCount: number;
  recentAgreementScores: number[];
}
```

---

## 简化得分

```typescript
function calculateConsensusScore(snapshot: SolutionSnapshot): number {
  const support = snapshot.supportCount;
  const rebuttal = snapshot.rebuttalCount;
  const agreement =
    snapshot.recentAgreementScores.length > 0
      ? snapshot.recentAgreementScores.reduce((a, b) => a + b, 0) /
        snapshot.recentAgreementScores.length / 10
      : 0.5;

  const base = support - rebuttal;
  const normalizedBase = Math.max(0, Math.min(1, 0.5 + base * 0.1));

  return Number((normalizedBase * 0.6 + agreement * 0.4).toFixed(3));
}
```

说明：

- 该公式的目标是“稳定、易解释”，不是“学术正确”。
- 如果后续业务证明不够用，再升级算法和表结构。

---

## 提前结束条件

命中以下全部条件时，视为达成简化共识：

1. 至少已有 2 个 AI 发言过
2. 当前领先方案得分 `>= 0.7`
3. 最近一轮中没有新的强反驳出现
4. 最近 2 个相关轮次内，该方案持续领先

否则继续辩论直到：

- 达到 `max_turns`
- 用户停止
- token 预算耗尽
- 运行失败

---

## 边界处理

### 无结构化结果

- 不中断辩论
- 本轮仅作为展示记录

### 多个方案平分

- 不提前结束
- 继续下一轮

### AI 从未提供 agreement_score

- 使用默认中性值 `0.5`

---

## 测试重点

- 能正确聚合支持/反驳数量
- 解析失败不会误判共识
- 平分时不会提前结束
- 连续领先判定正确

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.1 | 2026-03-07 | 收敛为 MVP 轻量共识，移除 V2 能力 |
| 1.0 | 2026-03-06 | 初始简化共识算法设计 |
