-- Seed: “民主集中制共识算法（先赛马，再相马）”策略
--
-- 用法（推荐）：
-- 1) 把下面的 email 改成你要作为策略 owner 的用户邮箱（或不改也行，会回退到最早创建的用户）
-- 2) 在 Postgres 里执行本文件
--
-- 注意：
-- - 本脚本会按 name+owner 删除旧策略（级联删除 roles/files），再重新插入
-- - 依赖 pgcrypto（gen_random_uuid），本项目 init.sql 已启用

begin;

do $$
begin
  if not exists (select 1 from users) then
    raise exception 'seed requires at least 1 user in table users';
  end if;
end $$;

with
picked_owner as (
  select owner_user_id
  from (
    (select id as owner_user_id from users where email = 'everxys@gmail.com' limit 1)
    union all
    (select id as owner_user_id from users order by created_at asc limit 1)
  ) t
  limit 1
),
deleted as (
  delete from strategies
   where owner_user_id = (select owner_user_id from picked_owner)
     and name = '民主集中制共识算法（先赛马，再相马）'
),
inserted_strategy as (
  insert into strategies (id, owner_user_id, name, description, is_shared, created_at, updated_at)
  select
    gen_random_uuid(),
    owner_user_id,
    '民主集中制共识算法（先赛马，再相马）',
    '先赛马再相马：全员议员实战 -> 民主选举主持人/监管者 -> 全员同角色轮换 -> 收敛为《小说细纲》。主持人禁提案；监管者可否决并回滚；平局最多两次后强制逻辑审核补信息。',
    true,
    now(),
    now()
  from picked_owner
  returning id
),
role_prompt as (
  select
    $sp$
你是辩论场“议员（Seat-X）”。默认身份永远是“议员”：你不预设人设，不被固定能力倾向限制。

硬性要求：
1) 输出必须是给人看的 Markdown（禁止输出 JSON 对象；如果你想输出结构化字段，请改写成 Markdown 标题与要点）。
2) 你必须遵守 protocol/00_ground_rules.md 与 protocol/*.md 中的流程规则。
3) 每一轮都以“本轮议题/主持人宣布的 Mode”为最高优先级；不要用“我不擅长”作为拒绝理由。
4) 你必须提供“新信息”：至少包含一个新的取舍/约束/风险/反例/合并建议（不能重复旧话）。

选举与职责切换：
- 在 Phase 2 之前：你只是一名议员，不自封主持人/监管者。
- 若投票结果与主持人宣布你当选【主持人】：
  - 你必须遵守 protocol/30_election_and_veto.md 的“主持人硬约束”：不准提出自己的方案，只做流程控制/汇总/投票/台账/输出《小说细纲》。
- 若投票结果与主持人宣布你当选【监管者】：
  - 你必须遵守 protocol/30_election_and_veto.md 的“监管者否决规则”：必要时一票否决并回滚到上一阶段，解除否决需多数同意。
- 若你未当选：
  - 继续作为议员参与每轮轮换讨论。
$sp$ as system_prompt
),
role_defs as (
  -- 修改席位数量：把 generate_series(1, 5) 的 5 改成你想要的默认席位数
  select
    gs as role_order,
    '通用议员' as role_name,
    (select system_prompt from role_prompt) as system_prompt
  from generate_series(1, 5) as gs
),
inserted_roles as (
  insert into strategy_roles (id, strategy_id, name, system_prompt, role_order, created_at, updated_at)
  select
    gen_random_uuid(),
    (select id from inserted_strategy),
    role_name,
    system_prompt,
    role_order,
    now(),
    now()
  from role_defs
  order by role_order asc
  returning id, role_order
),
common_files as (
  select *
  from (
    values
      (
        'debate/workflow.json',
        $f$
{
  "workflowVersion": 1,
  "enabled": true,
  "election": {
    "startRound": 3,
    "roles": ["Host", "Supervisor"],
    "speakingOrder": { "firstRole": "Host", "lastRole": "Supervisor" }
  },
  "seatOrderRules": [{ "afterRound": 1, "policy": { "type": "rotate", "offset": 1 } }]
}
$f$
      ),
      (
        'protocol/00_ground_rules.md',
        $f$
# 辩论场 Ground Rules（必须遵守）

1. 你当前是“议员”。除非选举结果明确指派你为主持人/监管者，否则不要自封官职。
2. 输出必须是给人看的 Markdown（禁止输出 JSON 对象）。建议结构：
   - ## 结论/主张（本轮你支持/推进的方案）
   - ## 支持点（要点列表）
   - ## 反对点（要点列表）
   - ## 风险/取舍（至少 1 条新信息）
   - ## 下一步（需要补的信息/验证路径）
3. 不要空谈方法论：每轮都要对“用户 IDEA”产生可落地的新信息（归类/冲突/取舍/风险/决策）。
4. 事实与假设要分开写：事实放“实事板”，假设放“待验证清单”。
5. 如果你发现主持人漏掉关键 IDEA / 流程违规 / 讨论陷入死胡同：用 rebuttal 明确指出，并给出纠偏方案。
$f$
      ),
      (
        'protocol/10_state_machine.md',
        $f$
# 四阶段闭环（状态机）

目标：先让所有 AI 以“议员”身份进行一轮实战；再民主选举主持人和监管者；之后以“全员同角色轮换”的节奏推进，直到真正收敛。

## Phase 1：议员实战演练（选举前）

每位议员独立输出：
- 对用户 IDEA 的理解（用你自己的话复述）
- 归类/聚类（给出分类名与成员）
- 合并建议（哪些点可以合并为一个更强的主张）
- 风险与矛盾（逻辑冲突、资源冲突、顺序依赖、隐藏成本）
- 你认为“谁适合做主持人/监管者”的理由（只做建议，不投票）

## Phase 2：民主选举（组建政府）

所有议员基于 Phase 1 的表现投票：
- 主持人（总结能力强、公正、流程意识强）
- 监管者（逻辑敏锐、找茬能力强、细节控）

投票必须给出：
- hostCandidate: 某个席位编号
- supervisorCandidate: 某个席位编号
- rationale: 简短理由

## Phase 3：动态轮换讨论（核心工作流）

由主持人宣布当前“模式”，并要求所有人（包括主持人/监管者/议员）统一切换：
- Mode A：创意架构师（只发散不批判，提出融合方案）
- Mode B：逻辑审核员（疯狂找茬，补齐约束，识别矛盾与优先级）
- 可选 Mode C：节奏分析员（拆里程碑、依赖、风险控制、验证路径）

## Phase 4：共识收敛与蓝图生成

当且仅当满足：
- 所有关键 IDEA 已被“吸收/合并/明确否决（给理由）”
- 风险与矛盾有明确处理方案
- 方案结构稳定（再讨论不会产生结构性变化）

主持人发起最终表决；监管者背书；主持人输出最终蓝图（小说细纲）。
$f$
      ),
      (
        'protocol/20_output_templates.md',
        $f$
# 输出模板（Markdown）

## Phase 1（演练）建议：

建议结构：
- ## 复述与边界
- ## 归类结果（分类 -> IDEA 列表）
- ## 合并建议
- ## 风险/矛盾清单
- ## 主持人/监管者候选建议（含理由）

## Phase 2（投票）建议：

建议结构：
- ## 投票
  - 使用官方工具投票（推荐）：调用 `debate_vote_cast`
    - selections: { "Host": "Seat-X", "Supervisor": "Seat-Y" }
    - reason: "一句理由"
- ## 理由（简短）

## Phase 3（轮换模式）建议：

建议结构：
- ## 本轮模式（跟随主持人宣布）
- ## 本轮产出
  - 创意架构师：提出方案/融合/取舍
  - 逻辑审核员：指出漏洞/约束/不可行点与修补建议

## Phase 4（最终表决）建议：

建议结构：
- ## 最终表决结论
- ## 主持人：蓝图摘要 + 决策清单 + 里程碑
- ## 监管者：流程合规背书（或指出遗漏并要求回到 Phase 3）
$f$
      ),
      (
        'protocol/30_election_and_veto.md',
        $f$
# 选举 / 否决 / 平局规则（强约束）

## 主持人（Host）硬约束
- 主持人不准提出自己的方案（不站队、不当作者）。
- 主持人只做：流程控制、汇总、发起投票、维护台账、输出最终《小说细纲》。

## 监管者（Supervisor）否决规则
- 监管者拥有“一票否决权”：
  - 否决发生时：必须回滚到上一阶段（例如从逻辑审核回滚到创意发散；或从最终表决回滚到逻辑审核）。
  - 否决解除：需要多数同意才能解除（重新投票表决“是否解除否决并继续”）。
- 监管者否决时必须给出：
  - 否决理由（遗漏/违规/死胡同/硬冲突未解）
  - 回滚后的“补做清单”（必须补齐哪些产物/检查哪些 IDEA）

## 投票规则（民主）
- 一人一票（每位参与者 1 票）。
- 计票与宣布结果（必须）：
  - 若还没有主持人（Host）产生：由 Seat-1 担任临时计票员（即使 Seat-1 不在最后发言，也必须在自己的回合主动检查其他议员的投票并汇总；若发现有人缺票/含糊，先点名催补，再在下一回合补齐后计票）。
  - 一旦主持人已被宣布就任：后续所有投票环节都由主持人负责计票与宣布结果。
  - 若计票员发现票型不完整/含糊（例如没写 Host/ Supervisor），必须要求对应议员补投票后再计票。
- 若出现平局：
  - 所有人必须先提出“新的观点/新证据/新取舍”，不能重复旧话；
  - 然后立刻重新投票。
- 平局最多允许连续发生 2 次：
  - 若仍平局，主持人必须强制切换到“逻辑审核员模式”补信息（找出导致分歧的缺失约束/证据），完成后再投票。
$f$
      ),
      (
        'protocol/40_idea_ledger_and_outline.md',
        $f$
# IDEA 台账 + 《小说细纲》模板（强约束）

## IDEA 台账（必须维护）
主持人每回合都要维护一个“IDEA 台账”，并在汇总中更新状态。
并且：每一轮主持人汇总时必须完整贴出台账全文（不是 diff）。

每条 IDEA 的状态只能是：
- 吸收（已合并进某个方案/章节/人物/伏笔）
- 合并（与其他 IDEA 合并成更强的条目）
- 否决（给出清晰理由：重复/不成立/破坏核心主题/资源不匹配等）
- 暂存（还没处理，但必须写明“待解决问题/需要的信息”）

重要规则（不遗漏定义）：
- 只有当所有 AI 都明确同意“该 IDEA 不重要/可忽略”，主持人才允许把它标记为“否决-可忽略”。
- 否则必须继续留在台账里（吸收/合并/暂存/否决-不可忽略）。

## 最终产物：《小说细纲》（建议结构）
1. 一句话核心卖点（Logline）
2. 主题与核心冲突（Theme & Central Conflict）
3. 主角 / 关键配角 / 反派（动机、弱点、成长弧）
4. 世界观与规则（限制条件 + 关键设定）
5. 关键反转清单（Twists：至少 3 个；含“以为死去的人翻盘”/“陷阱”类）
6. 故事结构（推荐三幕/起承转合）：
   - 幕 1：引子/设局/误导
   - 幕 2：升级/对抗/揭示
   - 幕 3：翻盘/代价/结局
7. 关键事件清单（必须，按时间线/因果链）：
   - 事件：发生了什么
   - 目的：推动什么冲突/人物弧光
   - 代价：牺牲/风险/不可逆后果
   - 悬念：留给下一事件的钩子
8. 伏笔与回收表（Foreshadowing Ledger）
9. 逻辑自检（因果链、角色动机一致性、设定不自相矛盾）
$f$
      ),
      (
        'templates/debate_question.md',
        $f$
你们将使用“民主集中制共识算法（先赛马，再相马）”对我的点子进行收敛，并最终输出一个可执行的《蓝图》。

我的所有 IDEA 如下（不要遗漏任何一个）：
<<<IDEAS>>>

IDEA 形态说明：
- 每条 IDEA 通常只有一句话（像“陷阱/反转/以为死去的人翻盘”这种）
- 你们必须把这些一句话 IDEA 逐条纳入台账处理

硬性流程（必须严格按顺序执行）：

Phase 1（议员实战演练，选举前）：
- 所有人以“议员”身份独立输出一份简短分析报告（理解复述、归类、合并建议、风险/矛盾）。
- 同时给出你认为“谁适合主持人、谁适合监管者”的建议理由（只是建议，不投票）。

Phase 2（民主选举）：
- 基于 Phase 1 的表现，所有议员投票选出 1 位主持人 + 1 位监管者，并说明理由。
- 形成明确结果后，主持人宣布就任（连任），监管者宣布就任（连任）。
- 主持人硬约束：主持人不准提出自己的方案，只能做流程控制/汇总/投票/维护台账/输出最终《小说细纲》。
- 投票规则：一人一票；若平局，所有人必须先提出“新的观点/新证据/新取舍”（禁止重复旧话），然后重新投票。
- 平局最多允许连续发生 2 次；若仍平局，主持人必须强制切换到“逻辑审核员模式”补信息（找出缺失约束/证据），完成后再投票。
- 计票与宣布结果（必须）：若还没有主持人（Host）产生，则由 Seat-1 负责计票并宣布当选结果；一旦主持人产生，后续投票都由主持人计票宣布。

Phase 3（动态轮换讨论，循环迭代）：
- 主持人每回合必须宣布当前统一模式（创意架构师 / 逻辑审核员 / 可选节奏分析员）。
- 所有人（包括主持人、监管者、议员）都必须切换到主持人宣布的同一模式并发言。
- 每个循环至少包含：一次创意发散 + 一次逻辑审核；必要时再补一轮发散修补。
- 监管者负责监督是否遗漏关键 IDEA、是否流程违规、是否陷入死胡同；必要时可一票否决并要求回滚到正确阶段。
  - 否决后必须回滚到上一阶段；解除否决需要“多数同意”投票通过。

Phase 4（共识收敛与蓝图生成）：
- 只有当所有 IDEA 都被明确标记为：吸收/合并/否决（给理由），并且主要矛盾得到解决路径，才允许进入最终表决。
- 主持人发起最终表决，监管者背书合规性，然后主持人输出最终《蓝图》。
  - 最终《蓝图》必须是《小说细纲》（包含：主题/核心冲突/人物弧光/世界观规则/关键反转/结构/关键事件清单/伏笔回收/逻辑自检）。

输出要求（每轮都必须满足）：
- 输出必须是给人看的 Markdown（禁止输出 JSON 对象）。
- 不限长度但要精炼：减少废话，增加可落地的新信息。
- “不遗漏”的严格定义：只有当所有 AI 都同意该 IDEA 不重要，才允许忽略；否则必须保留在台账中继续处理。
- 实事板记录哪些内容由主持人决定，但主持人必须确保：关键决策/关键定义不会丢失。
- 主持人每轮汇总时必须完整贴出 IDEA 台账全文（不是 diff）。

终止条件：
- 直到达成最终共识并输出《蓝图》才算完成；或者我手动停止辩论。
$f$
      )
  ) as t(path, content)
)
insert into strategy_role_files (id, strategy_role_id, path, content, created_at, updated_at)
select gen_random_uuid(), r.id, f.path, f.content, now(), now()
from inserted_roles r
cross join common_files f
order by 2, 3;

commit;
