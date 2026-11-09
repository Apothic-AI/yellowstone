# pi-profile-switch

[English](README.md) | [中文](README.zh-CN.md)

## 工具介绍

pi-profile-switch 为 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 提供命名 profile，让你按任务或场景来配置 Pi 的运行资源：

- 支持 skills、extensions、tools、MCP servers 以及 MCP server tools 过滤。
- 支持为 profile 指定默认模型、thinking level、以及追加的 instructions。
- 支持 pi-subagents 的子 agent 角色设定。
- 在同一会话内切换 profile，无需重启，保留会话历史。
- 同时使用全局 profile 和项目级 profile。
- 可以使用 overlay 在profile会话中临时禁用资源。

## 安装与使用

### 安装

```bash
npm install -g pi-profile-switch
```

需要 Pi 0.99.1 或更新版本，npm 会将其作为 peer dependency 安装。本包提供 `pi-profile` 启动器，请用 `npm install -g`，而不是 `pi install`。

### 启动

```bash
# 使用上次记住的 profile；没有记录时使用 default
pi-profile

# 明确使用 default，保持原生 Pi 行为
pi-profile default

# 使用初始 ask profile，进行问答与代码阅读
pi-profile ask

# -- 后的 Pi 参数原样传递
pi-profile ask -- --model openai/gpt-5.4
```

不指定名称时，先使用已信任项目记住的选择，再使用全局记住的选择，最后使用 `default`。命令行指定的 profile 只影响这次启动。

全局 profile 目录为空时，安装或启动会写入初始 [`ask`](examples/ask.json)。它关闭用户级 skills 和 extensions，只保留只读文件工具；MCP servers 仍按 Pi 的配置可用。你可以修改或删除它。

### 创建与修改 profile

可以直接保存 JSON 文件，格式和位置见下方[配置详解](#配置详解)。也可以使用随包提供的 [`profile-config`](skills/profile-config/SKILL.md) skill，通过对话创建、修改和删除 profile：

```text
创建一个名为 review 的全局 profile，只保留只读文件工具，禁用用户级 MCP servers。
```

使用对话配置时，当前 profile 需要允许 `profile-config` skill 和文件写入工具。可以先切换到 `default`。

`profile-config` 创建带有 `skills` 列表的 profile 时，默认加入自身，除非你明确排除它，或列表已有覆盖它的 glob。手动编辑 JSON 不会自动加入 skill。

### 会话内命令

| 命令                                                                          | 作用                                                               |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `/profile`                                                                    | 查看并选择 profile；非交互模式下打印列表。                         |
| `/profile use <name>`                                                         | 切换 profile，并记住选择供下次启动使用；切换失败时恢复原 profile。 |
| `/profile reload`                                                             | 重新读取当前 profile，应用文件修改。                               |
| `/profile status`                                                             | 查看当前 profile、已解析资源、路径、overlay、MCP 状态和诊断。      |
| `/profile overlay disable\|enable skill\|extension\|mcp\|tool <name-or-glob>` | 添加或移除当前会话的资源禁用条目。                                 |
| `/profile overlay clear`                                                      | 清除全部 overlay，恢复 profile 的资源选择。                        |

这些命令也适用于 Pi 的非交互模式，包括 `--mode text`、`--mode json` 和 `--mode rpc`。

### 临时禁用资源

```text
/profile overlay disable tool bash
/profile overlay enable tool bash
/profile overlay clear
```

overlay 只作用于当前运行，不修改 profile 文件，重启后失效。`enable` 需要与原禁用条目完全一致；使用 glob 禁用时，也要用同一个 glob 恢复。

overlay 只能收窄资源，不能增加 profile 未选中的资源。`default` profile 不支持通过 overlay 禁用 MCP server。

## 配置详解

### 文件位置与命名

每个 profile 对应一个 `<name>.json` 文件，文件名就是启动和切换时使用的名称。

| 路径                                        | 生效范围                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| `~/.pi-profile-switch/profiles/<name>.json` | 全局。设置 `PI_PROFILE_SWITCH_DIR` 后，改为该目录下的 `profiles/<name>.json`。 |
| `<项目>/.pi/profiles/<name>.json`           | 当前项目，仅在项目已信任时读取。                                               |

同名的项目级 profile 完全替换全局 profile，不合并字段。删除项目级文件后，全局定义重新生效。

名称必须以 ASCII 字母或数字开头，后续可包含 ASCII 字母、数字、点、下划线和连字符。`default` 是保留名称，不能创建 `default.json`，也不能编辑或删除 `default` profile。

项目尚未信任时，可以在 Pi 中执行 `/trust` 后重新启动，或通过以下方式仅信任本次启动：

```bash
pi-profile review -- --approve
```

### 完整示例

将下面的内容保存为 `review.json`。示例中的资源名称需要替换为你已安装或配置的名称，模型需要使用你可访问的 provider 和 model。

```json
{
  "label": "Code Review",
  "description": "Review code with selected resources",
  "skills": ["profile-config", "code-review"],
  "extensions": ["pi-subagents"],
  "mcps": ["github", "linear"],
  "tools": ["read", "grep", "find", "ls"],
  "mcp_tools": {
    "github": ["search", "get_issue"],
    "linear": []
  },
  "defaultProvider": "openai",
  "defaultModel": "gpt-5.4",
  "defaultThinkingLevel": "high",
  "instructions": "Focus on correctness and security. Do not modify files.",
  "subagents": {
    "defaultModel": "openai/gpt-5.4",
    "defaultThinking": "medium",
    "agentOverrides": {
      "reviewer": {
        "model": "inherit",
        "thinking": "high",
        "description": "Independent code review",
        "advertise": true
      }
    }
  }
}
```

JSON 顶层直接写 profile 对象。所有字段都可省略；省略的字段不增加 profile 控制，保留 Pi 的原生行为。字段类型可通过 [`schemas/profiles.schema.json`](schemas/profiles.schema.json) 校验。

### 字段参考

| 字段                   | 类型                       | 用途                                                                              |
| ---------------------- | -------------------------- | --------------------------------------------------------------------------------- |
| `label`                | `string`                   | 选择列表中的显示名称，不改变 profile 的文件名。                                   |
| `description`          | `string`                   | 选择列表中的说明。                                                                |
| `skills`               | `string[]`                 | 选择 skills，支持名称和 glob。                                                    |
| `extensions`           | `string[]`                 | 选择 extensions，支持标识、glob 和指定路径。                                      |
| `mcps`                 | `string[]`                 | 选择用户级 MCP servers，支持名称和 glob。                                         |
| `tools`                | `string[]`                 | 选择非 MCP 工具，支持名称和 glob，包含内置工具及 extension 提供的工具。           |
| `mcp_tools`            | `Record<string, string[]>` | 按 MCP server 选择工具，见下方 MCP 配置。                                         |
| `defaultProvider`      | `string`                   | 默认模型的 provider，需与 `defaultModel` 同时声明。                               |
| `defaultModel`         | `string`                   | provider 中的 model ID，需与 `defaultProvider` 同时声明。                         |
| `defaultThinkingLevel` | `string`                   | 默认模型的 thinking level；仅在上述两个模型字段均已声明时生效，使用 Pi 支持的值。 |
| `instructions`         | `string`                   | 追加到系统提示词的文本，不替换原系统提示词。                                      |
| `subagents`            | `object`                   | pi-subagents 的默认值和指定角色设置，见下方子 agent 配置。                        |

模型是否可用、认证和命令行参数的优先级由 Pi 处理。只声明 `defaultProvider` 或 `defaultModel`，不会设置 profile 的默认模型。同时声明两个模型字段时，无效的 `defaultThinkingLevel` 字符串会产生警告并被忽略，不会移除模型声明。

### 资源选择

profile 引用已有资源，不安装或复制资源。各类引用的写法如下：

| 资源字段     | 引用方式与示例                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `skills`     | skill 名称，例如 `"profile-config"`；glob，例如 `"review-*"`。                                                                    |
| `extensions` | 已安装的 package 名称或 source alias；多入口 package 的 `<package>:<relative path>`；独立文件的标识；glob；绝对路径或 `~/` 路径。 |
| `mcps`       | MCP 配置中的 server 名称，例如 `"github"`；glob，例如 `"internal-*"`。                                                            |
| `tools`      | Pi 中的非 MCP 工具名称，例如 `"read"`、`"bash"`；glob，例如 `"test_*"`。                                                          |

独立 extension 文件的标识是相对于 extensions 目录的路径，去掉 `.ts` 或 `.js` 后缀。例如 `conventions.ts` 对应 `conventions`，`sub/index.ts` 对应 `sub`。extension 路径必须为绝对路径或 `~/` 路径，不能使用相对路径。

资源列表中，省略字段表示不收窄该类资源；`[]` 表示不选择该类资源；非空数组表示只选择匹配的资源。例如：

```json
{
  "skills": [],
  "extensions": [],
  "mcps": [],
  "tools": ["read", "grep", "find", "ls"]
}
```

skill、extension 和 MCP server 的选择只收窄用户级资源。项目级资源的可见性由 Pi 的项目信任决定，不会被 profile 隐藏。Pi 原有的资源排除设置仍然有效。

`tools` 不限制 MCP 工具，也不会关闭 Pi 调用 MCP 所需的入口。要限制 MCP 工具，需要配置 `mcp_tools`；因此只读文件工具列表不会自动禁止 MCP 写入操作。

### MCP 配置

MCP server 的地址、启动命令和认证信息保存在 Pi 的 MCP 配置中。profile 只选择 server 和工具。

用户级配置按下面的顺序读取；后一个来源的同名 server 完全替换前一个来源的定义，不合并字段：

1. `~/.config/mcp/mcp.json`
2. `~/.agents/mcp.json`
3. `~/.agents/mcp/mcp.json`
4. `<agentDir>/mcp.json`，其中 `<agentDir>` 是 Pi 的用户目录，通常为 `~/.pi/agent`

已信任项目的 `.pi/mcp.json` 由 Pi 读取，其中的 servers 不受 `mcps` 或 `mcp_tools` 收窄。选择某个 server 不会强制启用源配置中已禁用的 server。

`mcp_tools` 的 key 必须是 server 名称，数组中的值必须是 Pi 原生 MCP 接口显示的工具名称，均不支持 glob。

| 写法                                | 效果                                             |
| ----------------------------------- | ------------------------------------------------ |
| 省略 `mcp_tools`，或写 `{}`         | 保持各 server 的原工具配置。                     |
| 在 `mcp_tools` 中省略某个 server    | 保持该 server 的原工具配置。                     |
| `"github": ["search", "get_issue"]` | 替换该 server 原有的工具选择，只允许匹配的工具。 |
| `"github": []`                      | 禁止该 server 的全部工具，不禁用 server 本身。   |

MCP 工具名称不会预先校验。写错名称仍会保留限制，但不会产生工具名称诊断；配置前应通过 Pi 查看 server 暴露的实际名称。

要长期保存 MCP 连接配置，请修改上述用户级文件。在 `pi-profile` 会话中通过 `pi mcp add` 修改的内容，会在下次切换或 reload 时被覆盖。

### 子 agent 配置

`subagents` 不会加载 pi-subagents，也不会自动添加 extension、授权委派工具或创建角色。使用这些设置前，需要通过 Pi 正常安装并加载 pi-subagents，并允许相应工具。

| 字段                                          | 类型              | 用途                                                                                                   |
| --------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| `subagents.defaultModel`                      | `string`          | 没有指定模型的子 agent 使用的默认模型。模型字符串采用 pi-subagents 的原生格式，例如 `openai/gpt-5.4`。 |
| `subagents.defaultThinking`                   | `string`          | 没有指定 thinking level 的子 agent 使用的默认值。                                                      |
| `subagents.agentOverrides`                    | `object`          | 按精确角色名称设置覆盖值；名称区分大小写，不允许 glob 或前后空白。                                     |
| `subagents.agentOverrides.<name>.model`       | `string \| false` | 设置角色模型；`"inherit"` 使用当前父会话模型，`false` 清除角色的显式模型设置。                         |
| `subagents.agentOverrides.<name>.thinking`    | `string \| false` | 设置角色 thinking level；`false` 清除角色的显式 thinking 设置。                                        |
| `subagents.agentOverrides.<name>.description` | `string`          | 角色描述元数据，不是子 agent prompt。                                                                  |
| `subagents.agentOverrides.<name>.advertise`   | `boolean`         | 是否列入父 prompt；`false` 隐藏这项介绍，不控制角色能否运行。                                          |

子 agent 的 thinking level 使用 schema 中的 `thinkingLevel` 支持值。所有子 agent 文本字段必须非空。

省略 `subagents`、写 `{}` 或只提供空角色对象，不增加子 agent 控制。声明某个角色不会排除其他角色。未声明的角色字段保留原生设置，显式 `false` 不等同于省略。

pi-subagents 的项目设置、provider 设置和每次调用的设置仍可能覆盖这些声明。`/profile status` 展示 profile 声明；`/subagents-models` 查看实际模型映射。模型格式和原生优先级见 [pi-subagents 模型文档](https://github.com/nicobailon/pi-subagents/blob/main/docs/models.md)。

### 应用修改与诊断

修改当前 profile 文件后，在会话中执行：

```text
/profile reload
/profile status
```

| 情况                                                  | 处理方式                                                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| JSON 格式错误、顶层不是对象或字段类型错误             | 激活失败；按错误中的文件路径和字段名修正后重试。                                                            |
| 未知顶层字段                                          | 字段被忽略并产生警告；按提示改用支持的字段。                                                                |
| `subagents` 中出现不支持的嵌套字段                    | 激活失败；按提示删除或改正该字段。                                                                          |
| skill、extension、MCP server 或非 MCP tool 引用未匹配 | 激活继续，报告警告并保留可用匹配；修正名称或安装资源后 reload。全部未匹配时，选择保持为空，不恢复全部资源。 |
| MCP server 未知、已禁用或只属于项目级配置             | 报告警告，不创建 server、不强制启用，也不修改项目级 server；检查用户级 MCP 配置和名称。                     |
| 用户级 MCP 配置格式错误                               | 报告配置路径并跳过该来源，继续使用其他有效来源；修正该文件后 reload。                                       |
| 模型或认证错误                                        | 按 Pi 的原生提示检查 provider、模型和凭据。                                                                 |
