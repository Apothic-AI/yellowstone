# 深度审查 2.8.9 prompt-cache-key 安全实现

## Goal

对 `2.8.9` 合并后的 prompt-cache-key 安全实现进行独立、深入的代码审查，重点验证配置迁移、精确 provider/model 隔离、最终 payload 变换、错误证据关联、事务写入与 rollback、隐私边界、并发行为和 Pi 0.85.1 契约；对确认的问题直接修复并增加永久回归测试。

## What I already know

- PR #12 已通过 merge commit `563f010` 合并，后续安全修正通过 PR #14 merge commit `720774b` 合入 `master`。
- 当前 npm `latest` 为 `2.8.9`；本审查针对合并后的源码，不重写已发布版本。
- Pi 0.85.1 不支持 `models.json.compat.supportsPromptCacheKey`；按模型 opt-out 必须保存在扩展自有配置中。
- 当前实现包含 v2 `promptCacheKey.omit`、最终 payload 删除、证据驱动 fix、配置 receipt/backup、rollback 和 FIFO provider response 关联。
- 用户明确要求主会话直接审查和处理，不使用 subagent。

## Assumptions

- “深度审查”包含发现问题后的直接修复，而不只是只读报告。
- 审查范围优先覆盖本次功能及其共享事务/路由基础设施；不进行与该功能无关的大规模重构。
- 若修复需要发布新版本，将先完成本地验证并单独报告，不自动发布。

## Requirements

- 审查 extension-owned config v1→v2 解析、归一化和 footerMode 保留。
- 审查 `promptCacheKey.omit` 精确键的输入约束、歧义和 provider/model 身份匹配。
- 审查 `before_provider_request` 的变换顺序、不可变性、runtime/env gates 及 Pi/core 已注入字段删除。
- 审查 HTTP 400 unsupported 证据识别，排除 value-validation、conditional-use 和泛化错误。
- 审查无 request ID 的 provider response FIFO 关联及 message_end 生命周期清理。
- 审查配置修复的 preview/confirmation、文件身份、权限、hash、原子替换、锁、backup、receipt 与 rollback。
- 审查多模型连续修复、重复 fix、已有 opt-out、用户后续修改及失败恢复。
- 审查隐私：不持久化或显示 prompt、payload、headers、credentials、raw errors、session id 或输出。
- 所有确认的问题必须有永久回归测试；用户可见行为变化同步中英文 README 与 frontend spec。

## Acceptance Criteria

- [ ] 形成按严重级别排序的审查结论，包含代码位置、影响和证据。
- [ ] 所有 P0/P1/P2 确认问题均修复或明确记录阻塞原因。
- [ ] 配置、请求、证据、事务、rollback、并发和隐私边界均有检查证据。
- [ ] 新增/更新回归测试覆盖每个修复。
- [ ] `npm run typecheck`、`npm test`、`npm run check:diff`、`npm run check:pack` 和 `npm run check` 通过。
- [ ] Trellis task validation 通过，工作树最终干净。

## Review Method

1. 建立功能数据流和状态机：error evidence → in-memory model category → confirmed fix → config/receipt → reload → final payload omit → rollback。
2. 对每个边界做静态审查和 adversarial fixture：缺失/损坏/竞争/重复/跨模型/路由/非交互。
3. 将疑点最小化为可复现测试；先证明失败，再修复。
4. 复核与 Pi 0.85.1 类型/schema 和项目 specs 的一致性。
5. 运行完整质量门禁并报告残余风险。

## Out of Scope

- 改写 PR #12、PR #14 或 npm 已发布历史。
- 与 prompt-cache-key 功能无关的 UI、adapter 或 stats 重构。
- 未经明确授权发布新 npm 版本、合并后续 PR 或部署。

## Technical Notes

- 主要实现：`index.ts`。
- 永久测试：`tests/review-findings.test.ts`、`tests/runtime-contracts.test.ts`、`tests/tool-ordering.test.ts`。
- 规范：`.trellis/spec/frontend/cache-adapter-footer-stats.md`、`hook-guidelines.md`、`privacy-guidelines.md`、`type-safety.md`、`quality-guidelines.md`。
- 当前基线：`master` at `5bd9de6`，package `2.8.9`，Pi dev baseline `0.85.1`。
