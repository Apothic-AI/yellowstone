# 为 `prompt_cache_key` 不兼容渠道提供可自动修复的精确配置

## Goal

在保留 PR #12 核心贡献和作者署名/积极性的同时，将其“按 provider/model 关闭 OpenAI-compatible `prompt_cache_key`”能力调整为符合 Pi 0.85.1 实际配置契约的方案：不向 Pi 原生 `models.json.compat` 写入未支持的 `supportsPromptCacheKey` 字段，而由 Pi Cache Optimizer 自己持久化精确的 provider/model 配置，并让小白用户可通过 `/cache-optimizer fix` 的确认流程自动完成安全配置。

## What I already know

- PR #12（`andyxqq/fix/prompt-cache-key-compat`，提交 `dd78abd`）提出 provider/model-scoped opt-out，保留已有 key，仅抑制扩展 fallback；其方向和测试贡献有价值。
- 系统 Pi 0.85.1 与项目 Pi 0.85.1 均没有原生 `compat.supportsPromptCacheKey`；Pi 0.85.1 的 `ModelConfig.load()` 会拒绝/忽略含该未知 compat 字段的 provider 配置。
- 原生 `supportsLongCacheRetention: false` 不能等价替代：它对 OpenAI Completions 与 Responses 的 `prompt_cache_key` 行为不同，并会同时改变 retention 语义。
- 当前扩展在加载时请求 `PI_CACHE_RETENTION=long`，并在 `before_provider_request` 为 `openai-completions` / `openai-responses` 缺失 key 的 payload 注入 session-id fallback。
- 当前全局 opt-out 为 `PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY=1` / `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=0`，无法只关闭一个 provider/model。
- 扩展已有自有配置文件 `pi-cache-optimizer-config.json`，当前 v1 仅持久化 `footerMode`，并已有原子写入模式。
- `/cache-optimizer fix` 已具备 preview、风险说明、显式确认、自检、备份、receipt 和 rollback，但这些事务目前面向 `models.json`；本需求不应写未获 Pi schema 支持的字段到 `models.json`。

## Assumptions (temporary)

- “适当合并”意味着保留 PR #12 的作者贡献，优先通过合并/摘取其提交后再在维护者分支上修正设计，而不是复制实现后抹去作者贡献。
- 用户期望的是最终请求能避免不兼容字段，而不只是停止扩展补字段；否则 Pi core 已经生成 key 时仍会 400。
- 自动修复必须保持现有安全约束：先预览、再确认；没有用户确认不得改配置。

## Open Questions

- 已解决：采用“证据驱动 + 明确主动入口”。检测到当前精确模型拒绝 `prompt_cache_key` 时，普通 `/cache-optimizer fix` 自动建议该修复；没有错误证据时，不自动关闭，但用户可执行 `/cache-optimizer fix prompt-cache-key` 主动配置。

## Requirements (evolving)

- 不把扩展私有字段放入 Pi `models.json.compat`。
- 使用扩展自有、版本化配置按精确 `provider/model` 身份持久化策略。
- 配置只保存 provider/model 标识与布尔/枚举策略，不保存 prompt、payload、响应正文、API key、headers、原始 session id 或模型输出。
- 请求阶段必须基于最终有效路由模型身份应用策略，不得按 provider 名字、base URL 或 API 类型猜测具体供应商能力。
- 为保证真正解决 400，明确 opt-out 应移除最终 payload 中的 `prompt_cache_key` / `promptCacheKey`，而不是只跳过本扩展 fallback；文档和确认预览必须明确这一影响。
- 未配置的模型保持现有行为：保留 Pi/调用方已有 key，并在符合现有 API gate 时注入扩展 fallback。
- 全局环境 opt-out 继续有效，不破坏现有用户配置。
- `/cache-optimizer fix` 应能对当前精确 provider/model 自动持久化 opt-out，必须展示 preview + 风险并取得用户确认；普通 `fix` 仅在明确的 `prompt_cache_key` unsupported 证据下自动建议，`fix prompt-cache-key` 是用户明确知情的主动入口。
- 配置写入扩展自有文件必须与现有 `models.json` 修复一样使用临时文件 + 原子替换，拒绝覆盖/符号链接风险，并保留 v1 `footerMode`。
- `/cache-optimizer rollback` 必须识别并撤销最新的扩展配置变更，同时继续支持既有 `models.json` receipt；不能因为 footer 配置存在而误删或重置它。
- 配置变更的 preview 必须说明精确 provider/model、最终会删除请求体中的 `prompt_cache_key` 与 `promptCacheKey`、可能失去 provider prompt-cache 命中，以及需 `/reload` 或重启 Pi。
- 英文和中文 README 同步更新。
- 保留 PR #12 的原作者贡献，最终集成方式需能在 Git 历史或共同作者信息中体现。
- 未经用户另行明确批准，不合并 PR、不推送、不发布、不部署。

## Acceptance Criteria (evolving)

- [x] Pi 0.85.1 能正常加载用户的 `models.json`；其中不需要也不出现 `supportsPromptCacheKey`。
- [x] 扩展配置可以精确表示某一 `provider/model` 的 `prompt_cache_key` omit 策略，并可无损迁移现有 v1 `footerMode`。
- [x] 未配置模型维持当前 fallback 和已有 key 保留行为。
- [x] 配置为 omit 的模型在最终 provider payload 中不包含 `prompt_cache_key` 或 `promptCacheKey`，包括 Pi core 预先提供 key 的情况；未配置模型仍保留已有 key并按原逻辑 fallback。
- [x] 其它 provider/model 不受影响；路由模型按最终 upstream identity 匹配。
- [x] `/cache-optimizer fix` 在明确 unsupported 证据或主动子命令下展示精确目标、将删除的字段含义和缓存影响，用户拒绝时不写文件，确认后原子持久化；普通无证据 `fix` 不误关闭。
- [x] 重复 fix 幂等；`/cache-optimizer rollback` 能安全恢复该扩展自有配置变更，或提供等价、清晰的一键重新启用流程，并保留 footer 配置。
- [x] 永不记录完整 provider 错误、prompt、payload、headers、session id 或输出。
- [x] 永久回归测试覆盖配置迁移、精确隔离、已有 Pi key 删除、fallback 抑制、确认拒绝/接受、幂等和恢复。
- [x] `npm run typecheck`、`npm test`、`npm run check:diff`、`npm run check:pack` 通过。

## Verification Notes

- PR #12 merge commit `563f010` remains in history；安全实现从 `b028f1e` 移植为 `e53a88d`，随后在 `9167136` 中明确移除了不受支持的 compat gate。
- `supportsPromptCacheKey` is no longer part of the extension compat type or fallback decision. Any occurrence in `models.json` is rejected by the extension's effective-compat validation, while the request fallback remains API-gated.
- The extension-owned v2 config stores exact `provider/model` entries under `promptCacheKey.omit`; final payload handling removes both key spellings after other request mutations.
- Pi development dependencies and local CLI resolve to `0.85.1`; the project peer range remains `>=0.82.0`.
- `npm run check` passes with 95 tests, typecheck, diff validation, and a `2.8.9` dry-run package.

## Definition of Done

- 实现和永久测试完成。
- 双语 README 与 frontend spec 更新。
- 完整项目门禁通过。
- PR #12 的贡献归属保留且最终差异经过复核。
- 仅在用户最终明确批准时才执行远端 PR 更新或合并。

## Research References

- `research/pi-0.85.1-prompt-cache-key.md` — 由本会话前序审查确认 Pi 0.85.1 schema 与两种 OpenAI API 的最终 wire 行为；未使用子代理。
- `research/fix-ux-and-attribution.md` — 由本会话前序审查确认现有 fix/rollback 事务、扩展配置迁移与保留外部贡献的集成方案；未使用子代理。

## Research Notes

### Feasible approaches

**Approach A: 扩展配置 + 最终 payload omit + 证据驱动 fix（推荐）**

- 将精确策略存入 `pi-cache-optimizer-config.json`，从 v1 无损迁移到 v2。
- 在最终 `before_provider_request` 中先删除两个 key 命名，再跳过 fallback。
- 明确 unsupported 证据在进程内按精确 provider/model 记录；普通 `/fix` 仅对该证据提供修复，`/fix prompt-cache-key` 允许用户明确主动选择。
- 复用安全交互原则，但针对扩展配置文件建立独立的 privacy-safe receipt/备份或等价恢复流程，不触碰 `models.json`。
- 优点：真正解决 Pi core 和扩展两条注入路径；不污染 Pi schema；小白用户能通过命令完成；误判最少。
- 缺点：首次请求仍会失败一次；需要增加配置 v2、错误证据分类、fix UI 与恢复测试。

**Approach B: 扩展配置 + 用户主动 fix 选择**

- 用户可直接从 `/fix` 或菜单关闭当前模型 key，无需先产生 400。
- 优点：小白用户可主动配置。
- 缺点：用户可能误关有效缓存，且 `/fix` 的“修复已检测问题”语义变弱。

**Approach C: 借用 `supportsLongCacheRetention: false`**

- 不采用。对 Responses 无效、语义过宽，且当前扩展会补回 key。

## Decision (ADR-lite)

**Context:** Pi 0.85.1 没有 `supportsPromptCacheKey`，而未知 compat 字段会让 `models.json` provider 配置失效。用户又需要按精确 provider/model 自动处理拒绝该字段的 endpoint。

**Decision:** 使用扩展自有版本化配置，不借用 Pi 原生但语义不等价的字段。明确 opt-out 的 wire 语义为最终 omit，并通过 `/cache-optimizer fix` 的安全确认流程提供自动配置：有明确 unsupported 证据时普通 `fix` 自动建议；无证据时仅由用户执行 `fix prompt-cache-key` 主动开启。扩展配置事务独立于 `models.json` receipt，但共享确认、原子写入、隐私和恢复约束。保留 PR #12 的核心测试/文档贡献与作者归属，但不原样采用其未受 Pi 支持的配置位置。

**Consequences:** 配置与 Pi schema 解耦，能覆盖 Pi core 已注入 key 的场景；需要扩展配置 v2 迁移、错误证据关联、fix UI 与恢复测试。

## Out of Scope

- 修改或发布 Pi upstream。
- 按 provider 名称建立硬编码黑名单。
- 静默自动写配置，或在首次 400 后未经确认自动重试/永久禁用。
- 修改 cache adapters、footer stats 计数、prompt reorder、tool ordering 或其它无关行为。
- Pi 0.85.1 项目开发基线升级已作为当前修正分支的前置提交完成；本任务不再引入其它依赖升级。

## Technical Notes

- 外部 PR：<https://github.com/jiangge/pi-cache-optimizer/pull/12>
- PR 提交：`dd78abd3e018b4982e029b5232d250f03051cef1`
- 主要代码：`index.ts` 的 config v1、effective route model、`before_provider_request`、provider error evidence、fix/rollback command。
- 永久测试：`tests/runtime-contracts.test.ts`，可能需要补充命令事务测试文件中的配置场景。
- 安全规范：`.trellis/spec/frontend/quality-guidelines.md`、`.trellis/spec/frontend/cache-adapter-footer-stats.md`、`.trellis/spec/frontend/hook-guidelines.md`、`.trellis/spec/frontend/type-safety.md`。
