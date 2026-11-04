# pi-lmm 动态模型发现：实现与验证说明

日期：2026-11-04（Asia/Taipei）

仓库：[TokenNotIncluded/pi-lmm-provider](https://github.com/TokenNotIncluded/pi-lmm-provider)

改动与最终检查：[PR #15](https://github.com/TokenNotIncluded/pi-lmm-provider/pull/15)

## 解决的问题

此前模型能力主要依赖 Pi 内置目录的精确 ID，以及随插件发布的 models.dev 静态快照。快照更新器还限定了八家厂商。厂商新增型号、Pi 尚未收录型号或模型名称写法不同，都可能使已经获得 LMM 授权的模型无法进入选择器。

现在模型名称和厂商来自运行时目录。新模型只要出现在 LMM 账户授权目录和 models.dev 中，并具备受支持的协议、完整聊天能力资料及可用的价格来源，就可以进入选择器，无需为每个新型号发布插件。供应商协议本身发生变化时，仍需要适配对应协议。

## 数据和请求的职责

| 数据来源 | 作用 |
| --- | --- |
| LMM `/api/oauth2/catalog` | 决定账户可以使用的模型、组、协议和账户价格 |
| models.dev `api.json` | 提供厂商、模型名称、canonical identity、上下文和输出上限等公开资料 |
| 已安装的 Pi 模型档案 | 保留已经验证的 reasoning、图像与协议兼容选项 |
| 本地公开资料缓存与随包快照 | 在刷新失败、离线或冷启动时提供回退资料 |

模型名称匹配只用于读取能力资料。实际请求始终发送 LMM 目录里的原始 `upstream_model` 和原来的组标识，权限与结算继续由 LMM 验证。

## 名称匹配

优先精确 ID，其次匹配规范化 ID、厂商命名空间、目录提供的显示名称和 `canonical_model_id`。大小写、空格和分隔符差异可以被消除；版本数字、参数规模和 `mini`、`pro`、`flash`、`thinking`、`preview` 等变体词会保留。例如 `FutureVendor/Novel_v7_2_flash` 可以匹配 `futurevendor/novel-v7.2-flash`，但不会匹配另一版本或 `pro` 变体。

不同 canonical identity 的同名记录视为歧义。某条完整记录缺少 canonical ID 时，也不能仅因另一条记录有该字段就将前者丢弃。能识别出 canonical 厂商自己的记录时优先采用；其余同一 canonical 模型的兼容记录使用保守的容量交集。缺失资料的代理商记录不会否决有效的 canonical 来源。

## 自动刷新和缓存

- 普通联网模型发现使用 24 小时的公开资料缓存。
- `/lmm-prices` 强制刷新公开资料，再重建账户模型目录。
- 公开请求固定访问 `https://models.dev/api.json`，超时上限为 5 秒，响应上限为 32 MiB，并拒绝重定向。
- 公开缓存位于 `<agent-dir>/lmm-models-dev/catalog-v1.json`，包含原始公开 JSON、抓取时间和 SHA-256，通过临时文件加原子重命名保存。
- 加载缓存时验证大小、摘要、时间和数据结构。刷新失败保留最近有效资料；没有有效缓存时使用随包快照。
- 网络禁用的发现过程只读本地资料。公开缓存与 OAuth 会话绑定的账户模型缓存分开，公开数据不能授权另一个账户。

models.dev 请求不携带 OAuth token、提示词、账户模型列表或余额。目录中的供应商 URL、headers 和 credentials 不会成为 LMM 的请求配置。

## 保留的协议和计费边界

已经存在于 Pi 的同一模型继续使用已验证的推理和图像配置。仅由公开目录新识别出的模型采用保守文本配置；`reasoning: true` 本身不能说明厂商采用哪一种推理控制字段。

非聊天、混合媒体输出、无工具能力或能力资料不完整的条目继续在 `/lmm-prices` 中显示原因。LMM 原生价格优先；缺少原生价格时，只采用同一已验证模型的 Pi 参考价。缺价不会被填成零，也不会混用另一模型或另一供应商的实际报价。

## 验证依据

| 行为 | 回归依据 |
| --- | --- |
| 新厂商和新型号无需新增白名单 | `test/model-matching.test.ts`、`test/metadata-update.test.mjs` |
| 名称格式可变化，版本和变体保持区别 | `test/model-matching.test.ts` |
| 同名不同 canonical、部分缺 canonical 时拒绝歧义 | `test/model-matching.test.ts` |
| 新模型进入选择器且请求保留原始 LMM ID | `test/dynamic-models.test.ts` |
| 强制刷新识别新发布的模型 | `test/dynamic-models.test.ts` |
| 缓存恢复、超时、坏 JSON、取消、过大响应和写入失败 | `test/models-dev-cache.test.ts` |
| 账户与价格边界继续有效 | `test/dynamic-models.test.ts`、`test/catalog.test.ts` |

以下资源可控的本地检查通过，共 44 项：

```sh
node --experimental-strip-types --test \
  test/model-matching.test.ts test/models-dev-cache.test.ts \
  test/metadata-update.test.mjs test/catalog.test.ts test/http.test.ts
git diff --check
```

GitHub Actions 还执行 `npm run typecheck`、完整 `npm test`、`npm run pack:check` 和 `npm run test:pi`。兼容矩阵覆盖 Pi 0.86.1、0.87.1、0.99.2、1.0.4 和当前 latest；独立集成任务覆盖锁定的 Pi 1.2.0。最终提交的结果以 PR 检查记录为准。

兼容检查同时修复了测试环境混装 Pi 子包的问题：现在先把目标 Pi 版本解析成一个精确版本，再从该版本的包清单发现同组织依赖，并一次性安装同一版本的整组依赖。旧版本没有的子包无需硬编码例外。与固定模型目录有关的测试改用独立样例，旧版宿主不提供设置 API 时验证显式刷新恢复路径。

这些测试使用样例授权和模拟响应，未使用生产账户或付费模型请求。npm 发布与真实生产验收仍属于独立步骤。

## 使用本次分支

```sh
npm exec --yes --package=@tokennotincluded/pi-lmm-provider@alpha -- lmm-pi-provider git:github.com/TokenNotIncluded/pi-lmm-provider@fix/dynamic-models-dev-discovery
```

重启 Pi，执行 `/lmm-prices`，再用 `/model` 选择模型。之后常规模型资料更新由运行时刷新处理。分支的合并状态见 PR #15。

## 上游资料

- [models.dev 稳定 API 说明](https://github.com/anomalyco/models.dev/blob/dev/README.md)
- [模型 schema 与 canonical_model_id](https://github.com/anomalyco/models.dev/blob/dev/packages/core/src/schema.ts)
- [canonical identity 的生成](https://github.com/anomalyco/models.dev/blob/dev/packages/core/src/generate.ts)
- [Pi 包管理与 Git ref 安装](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
