# Bilingual documentation proposal (English + 简体中文)

Exact proposed wording for the user-facing documentation that lands with the implementation stage. Both editions
change in the same commit: `test/resource-selection-docs.test.ts` compares field rows across editions and derives
field coverage from `schemas/profiles.schema.json`, so a one-sided edit fails a test that names the missing field.

Scope of the readable change: one field row, the project-override paragraph, the omitted/empty guidance, and the
project-scope limitation. Nothing else in either README is rewritten, and no migration or release history is
added.

## 1. Project override paragraph

`README.md` — replaces the sentence "A project-level profile completely replaces a same-named global profile
without merging fields. Deleting the project file makes the global definition available again." under
`### File locations and names`.

> A project-level profile completely replaces a same-named global profile without merging fields. Deleting the
> project file makes the global definition available again.
>
> Set `"promptStrategy": "append"` in a project profile to compose it with its same-named global profile instead.
> The composed profile may add user-level resources the global selection leaves out, and it never narrows what the
> global profile already allows; use a replacing profile or `/profile overlay` to narrow. When the project file
> declares `append` and no global profile of that name exists, the project profile works on its own: its own
> resource lists apply exactly as written, and a note records that no base was found.

`README.zh-CN.md` — replaces "同名的项目级 profile 完全替换全局 profile，不合并字段。删除项目级文件后，全局定义重新生效。"
under `### 文件位置与命名`.

> 同名的项目级 profile 完全替换全局 profile，不合并字段。删除项目级文件后，全局定义重新生效。
>
> 在项目级 profile 中设置 `"promptStrategy": "append"`，即可改为与同名的全局 profile 组合。组合后的 profile 可以补充全局选择未包含的
> 用户级资源，但不会收窄全局 profile 已经允许的内容；需要收窄时请使用替换式的 profile 或 `/profile overlay`。如果项目级文件声明了
> `append` 但不存在同名全局 profile，项目级 profile 会单独生效：其自身的资源列表按原样应用，并提示未找到可组合的全局定义。

## 2. Field reference row

Declared in `schemas/profiles.schema.json` between `description` and `skills`, and added at the same position in
both field tables.

`README.md`

| Field | Type | Purpose |
| --- | --- | --- |
| `promptStrategy` | `string` | Accepted values are exactly `"append"` and `"replace"`; an omitted field means `"replace"`. In a project profile, `"append"` composes this definition with the same-named global profile, and `"replace"` replaces it. `"append"` is rejected in a global profile; `"replace"` is accepted there and changes nothing. |

`README.zh-CN.md`

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `promptStrategy` | `string` | 接受的值只有 `"append"` 和 `"replace"`；省略该字段等同于 `"replace"`。在项目级 profile 中，`"append"` 表示与同名的全局 profile 组合，`"replace"` 表示替换。在全局 profile 中声明 `"append"` 会被拒绝；声明 `"replace"` 会被接受，且不产生任何影响。 |

Alignment is free: the existing tables are aligned by a formatter and the documentation test accepts any
equivalent alignment and prose.

## 3. Omitted and empty guidance

`README.md` — appended after the paragraph that explains omission versus `[]` and before the JSON example in
`### Resource selection`. The JSON example is unchanged.

> The same field means the same thing in a composed profile, with one addition: a reference a composed profile
> cannot apply is named in a diagnostic instead of being silently dropped. If the global profile leaves a kind
> unrestricted, adding references to that kind in the project profile is reported as unapplied, because an
> unrestricted kind already includes everything; declare the kind in the global profile (even as `[]`) to widen it
> from the project profile. When no global profile of that name exists at all, the project profile's own lists
> apply exactly as written and nothing is reported as unapplied.

`README.zh-CN.md` — 追加在 `### 资源选择` 中解释省略与 `[]` 区别的段落之后、JSON 示例之前。示例本身不变。

> 在组合后的 profile 中，同一字段的含义相同，只有一点补充：组合后无法应用的引用会在诊断信息中列出，不会被静默丢弃。如果全局 profile
> 对某一类资源不作限制，那么在项目级 profile 中为这一类添加引用的结果会被报告为“未应用”，因为不作限制本身就代表已包含全部资源；
> 若希望从项目级 profile 扩展该类资源，请在全局 profile 中声明该字段（即使是 `[]`）。如果根本不存在同名的全局 profile，
> 项目级 profile 自身的列表按原样应用，不会有任何引用被报告为“未应用”。

## 4. Project-scope limitation paragraph

`README.md` — replaces the paragraph "Skill, extension, and MCP server selections narrow only user-level
resources. Pi's project-trust decision governs project-level visibility; profiles do not hide those resources.
Pi's existing resource exclusions remain effective."

> Skill, extension, and MCP server selections narrow only user-level resources. Pi's project-trust decision governs
> project-level visibility; profiles do not hide those resources, and a composed (`append`) profile does not either.
> A trusted project's `.pi/skills/` and `.pi/extensions/` stay visible under every profile, including one that
> declares `append`, because that visibility is Pi's trust gate rather than something a profile controls. Pi's
> existing resource exclusions remain effective.

`README.zh-CN.md` — 替换 “Skill、extension 和 MCP server 的选择只作用于用户级资源。项目级资源的可见性由 Pi 的项目信任决定，profile
不会隐藏这些资源。Pi 已有的资源排除规则继续生效。”

> Skill、extension 和 MCP server 的选择只作用于用户级资源。项目级资源的可见性由 Pi 的项目信任决定，profile 不会隐藏这些资源，
> 声明 `append` 的组合式 profile 同样不会。已信任项目的 `.pi/skills/` 与 `.pi/extensions/` 在任何 profile 下都保持可见，
> 包括声明 `append` 的 profile，因为这是 Pi 的信任判定，不由 profile 控制。Pi 已有的资源排除规则继续生效。

## 5. Obligations for the implementation stage

- Edit `README.md` and `README.zh-CN.md` in the same commit; never one edition alone.
- Keep identifiers, JSON, commands, behavior statements, and limitations identical across editions; prose may
  differ in wording but not in claims.
- Do not restate ADR reasoning, implementation mechanisms, or internal spec links in either edition.
- The field row must exist before `test/resource-selection-docs.test.ts` runs, because that test derives required
  rows from the schema and compares editions.
- English is the source of truth for the technical claim; the Chinese edition is a translation of the same claim,
  not an independent description.

## 6. What the docs deliberately do not say

- No claim that `append` restricts or closes the project-scope resource route.
- No claim that an unapplied reference is validated, an error, or a typo report.
- No migration section, no release history, no "restart the fleet" instruction.
- No statement that rollback is free; the rollback prerequisite belongs to the release record, not the README.
