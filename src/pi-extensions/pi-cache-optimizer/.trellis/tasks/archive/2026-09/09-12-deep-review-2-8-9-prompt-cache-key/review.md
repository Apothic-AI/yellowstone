# 2.8.9 prompt-cache-key 深度审查结论

## 结论摘要

确认 5 个问题：2 个 P1、3 个 P2。均已修复并增加永久回归测试；未发现 P0。审查未改写已发布的 2.8.9 历史，也未执行发布、push 或 PR 操作。

## 已确认并修复的问题

### P1 — extension-config rollback 未绑定预览时 receipt

- 位置：`index.ts:2172-2246`、`index.ts:2361-2468`
- 影响：用户确认 rollback 后，另一进程可替换或原地改写 config receipt。旧实现仍按预览得到的旧 receipt 修改配置，随后可能覆盖新 receipt，导致事务身份与实际配置不一致。
- 证据：race fixture 在 receipt 最终提交边界替换 receipt；旧实现会完成旧 rollback。
- 修复：读取 receipt snapshot（regular-file identity + SHA-256）；确认后、加锁后、配置变更前及 receipt 原子提交前重复校验。任何替换或原地改写均拒绝。
- 回归测试：`tests/review-findings.test.ts:2977`。

### P1 — rollback/fix 的 receipt 写入失败可能留下半提交配置

- 位置：`index.ts:2248-2350`、`index.ts:2361-2468`
- 影响：配置已经修改/回滚后，如果 receipt 创建或状态标记失败，旧实现可能留下“配置状态已变化、receipt 状态未变化”的不一致结果；fix 的补偿失败还被静默吞掉。
- 证据：对已存在和原先不存在的配置分别注入 receipt 路径失败；对 rollback 在 receipt 最终提交边界注入失败。
- 修复：receipt 标记纳入 rollback 事务；失败时在 identity/hash/mode guard 下恢复精确 post-fix 配置。原先不存在的配置通过 atomic no-replace 重新创建。fix 补偿失败不再吞掉，而是报告双重失败。
- 回归测试：`tests/review-findings.test.ts:2952`、`:2977` 及新增的 absent-target 补偿 fixture。

### P2 — 不存在的配置存在最终 rename 覆盖窗口

- 位置：`index.ts:2027-2098`、`index.ts:2298-2344`、`index.ts:8826-8857`
- 影响：absence check 与 `rename()` 之间若用户或外部进程创建配置，旧实现会原子地覆盖新文件，违反“出现/变化即拒绝”的事务约束。
- 证据：在最终提交边界创建竞争文件；旧 rename 语义会覆盖目标。
- 修复：同目录临时 regular file + hard link 实现 atomic no-replace create；已存在目标仍使用带 identity/hash/mode guard 的 atomic replacement。receipt 首次创建也使用同一 no-replace 语义。
- 回归测试：`tests/review-findings.test.ts:3005`。

### P2 — unsupported 证据语法过宽

- 位置：`index.ts:3813-3835`
- 影响：参数值不支持、仅在特定条件下不允许等错误会被误判为字段能力缺失，普通 `/cache-optimizer fix` 因而可能建议永久关闭该模型的 key。
- 证据：value-validation 与 conditional-use adversarial fixtures 在旧 matcher 中返回 true。
- 修复：改为 grammar-bound field-level matcher；字段名必须直接绑定 unsupported/unknown/unrecognized 等能力拒绝，不跨越 value 或 conditional 子句推断。
- 回归测试：`tests/review-findings.test.ts:2887-2901`。

### P2 — 不同模型并发响应会被 FIFO 错误归因

- 位置：`index.ts:11030-11055`、`index.ts:11141-11167`
- 影响：Pi 的 provider response event 无 request ID。两个不同模型同时 pending 且响应乱序时，旧 FIFO 会把 header-only 证据记录到先发请求，导致错误模型获得 fix 建议。runtime disabled 时又完全不记录请求身份，使 always-on Anthropic TTL 安全修复可能退回当前活动模型。
- 证据：并发 A/B 请求、B 先返回的 fixture；旧实现将 B 的 header 归到 A。
- 修复：不同 exact model 同时 pending 时将关联标记为 ambiguous，不记录 header-only 模型证据；最终 assistant message 有 exact provider/model 时再恢复归因。相同 exact model 并发仍可安全归因。credential-blind 请求快照在 runtime disabled 时继续保留，供 always-on TTL 安全逻辑使用。
- 回归测试：`tests/review-findings.test.ts:1784`、`:1851`。

## 已核验但未发现缺陷的边界

- v1 config 读取和 v2 归一化保留 `footerMode`；未知字段、混合类型 omit 和私有数据被拒绝。
- 精确 opt-out 只匹配 `${provider}/${modelId}`，最终 request stage 同时删除两种 key 拼写，并保留无关 payload 字段。
- 普通 fix 无明确证据时不写配置；显式 `fix prompt-cache-key` 仍需交互预览与确认。
- 多模型连续 fix 保留先前 opt-out；重复 direct fix 不产生新 backup/receipt；最新 rollback 只撤销 receipt-owned key。
- 配置、backup、receipt 的 regular-file、hash、mode、basename 和 atomic write 边界已检查；`footerMode` 不被 rollback 顺带删除。
- receipt/config/stats 不包含 prompt、payload、headers、credentials、raw provider error、raw session id 或模型输出。response 关联快照仅保留 credential-blind provider/model/api/必要 compat 元数据。
- Pi 0.85.1 类型/schema 中没有 `supportsPromptCacheKey`；实现只使用 extension-owned config，不写该字段到 `models.json`。

## 残余风险（P3）

- Pi provider response hook 仍没有 request ID。对不同模型的并发 header-only 错误只能选择“丢弃歧义证据”，无法无损关联；这是上游事件契约限制。最终 assistant message 携带 exact provider/model 时可恢复。
- 文件系统 API 无法阻止同一权限主体在最后一次检查后的所有恶意 TOCTOU 行为；当前实现通过 transaction lease、regular-file identity/hash/mode 重检和 no-replace create 将正常并发及可检测替换收敛为拒绝。

## 验证

- `npm run typecheck`
- `npm test`（102 tests at the first full run; final count may increase with the added permanent fixtures）
- `npm run check:diff`
- `npm run check:pack`
- `npm run check`
- Trellis task validation
