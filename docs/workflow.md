# Vibecoding 工作流

## 确定性游戏内测试

游戏内验收采用确定性测试状态机，而不是“看到截图就算成功”：

1. `runClient` 仅负责启动客户端和桥接。
2. `mc_test_scenario` 根据实际功能创建带目标 ID 与断言的测试规格。
3. `mc_run_test` 在专用 `ModCrafting Test World` 内准备环境、执行动作、采集动作后的快照、逐项断言并清理。
4. 只有 `PASS` 可结束测试；`FAIL` 需清理后复测一次才会触发修复；`INCONCLUSIVE` 显示缺失证据并暂停，绝不把导航、桥接或视觉问题当成代码错误。

计划终端顺序固定为“实现 → 构建 → 启动客户端/桥接 → `game_test`”。执行阶段只会对真实的 `submit_plan` 调用给出阶段提示；其他被门控的工具保留原工具名和允许列表，避免错误提示驱动的调用循环。恢复历史会话时会迁移旧的 `inspect + mc_run_test` 步骤，并恢复保存在计划或工具 JSON 中的场景规格。

截图是报告附件，不能单独通过测试。物品、方块、配方、实体、交互和 GUI 分别使用注册表、背包/主手、方块/实体快照、命令结果、Screen/控件状态等客观证据；纯视觉布局交由用户确认。

ModCrafting 把 **AI 对话式开发（Vibecoding）**、**Fabric 工程脚手架**、**一键游戏内测试** 和 **离线构建环境** 整合进同一个 Electron 桌面应用。

## 核心流程

```
用户描述想要的功能
    ↓
AI 规划并修改项目文件（Plan → Execute）
    ↓
在「游戏」面板启动客户端验证
    ↓
崩溃报告一键送回 AI 修复
```

## 三模式智能路由

每轮独立 LLM 分类，自动分流至三种模式：

| 模式 | 触发场景 | 工具集 | 行为 |
|------|---------|--------|------|
| **Chat** | 概念问答、方案说明 | 禁用写入/执行工具 | 直接给最佳方案不做比较 |
| **Plan** | 开发任务 | 只读工具 + `submit_plan` | 1-6 步结构化计划 |
| **Execute** | 计划已批准 | 全部工具（按步骤门控） | 逐步执行，每轮必调工具，旁白 ≤2 句 |

同时识别错误报告、用户症状、游戏内验证请求等侧面信号并注入到目标块中。

## Plan → Execute 双阶段

### Plan 阶段

- **目的**：让 AI 先勘探项目再给出结构化计划
- **工具**：只读工具（`list_directory`、`read_file`、`grep`、`fabric_docs_search` 等）+ `submit_plan` + `ask_clarification`
- **门控**：`plan-phase-gate.ts`
  - `MAX_READONLY_ROUNDS = 15`：超过 15 轮只读勘探后进入"建议提交"状态
  - 锁定后仍允许 `grep` / `list_directory` / `read_file`，仅禁用写入工具
  - 措辞为"建议尽快提交"而非"已锁定"
- **输出**：`submit_plan`（write / recipe / mixin / inspect 实现步骤；游戏功能附带严格断言的 `gameTest`）

### 计划编译

`plan-compiler.ts` 处理管道：解析 → 剥离主机终端步骤 → 删除模糊步骤 → 按路径去重 → 追加构建+运行步骤。

### Execute 阶段

`workflow-engine.ts` 串行逐步执行：

- 每轮执行**全部**允许的工具（只读并行，写入串行）
- 知识查询工具不消耗 attempt 配额
- 构建失败自动进入修复模式（最多 3 轮修复）
- 支持 `ask_clarification` 暂停向用户提问

## 澄清提问

`ask_clarification` 工具：

- **允许场景**：产品偏好、需求歧义
- **禁止场景**：代码事实（API 命名、类名、mixin 路径等）必须走工具勘察
- 执行阶段通过 `ClarificationNeeded` 事件 + ChatPanel 横幅 UI 交互

## 项目向导

图形化新建项目：

- **输入**：Mod ID、包名、作者、版本
- **自动生成**：`build.gradle`、`fabric.mod.json`、入口类
- **捆绑 mod**：从 `resources/_base_mods/` 复制 Mod Menu、ModCrafting Observer 等

## 模板快速创建

7 种内置模板，表单填写后跳过 Plan 阶段，直接由 `fabric_template_generate` 工具透传生成：

| 模板 | 说明 |
|------|------|
| 自定义方块 | Block with Item |
| 自定义物品 | Simple Item |
| 自定义食物 | FoodComponent |
| 自定义实体 | Entity + Renderer |
| 自定义工具 | ToolItem / Tier |
| 自定义护甲 | ArmorMaterial |
| 自定义配方 | Recipe JSON |

## 项目勘探

计划阶段前自动读取：
- `fabric.mod.json`
- `*.mixins.json`
- 资源目录结构

注入到系统提示词，供 AI 了解项目当前状态。

## 崩溃 → AI 修复

1. 自动检测崩溃报告（`mc-runtime.ts`）
2. 一键附加到对话上下文
3. 构建失败进入修复模式：先改码再构建
4. 修复模式最多 3 轮，失败则报告用户

## 图形化游戏测试

- 多实例支持（独立 `gameDir` 与 Gradle 守护进程）
- 阶段进度条
- 人话摘要（避免原始 Gradle 日志噪音）
- 独立 `GRADLE_USER_HOME` 隔离

## 上下文压缩

- 老旧工具结果微压缩
- 接近 token 上限触发 LLM 摘要
- 跨轮诊断保留（近期 5 条用户反馈 + 2 条助手摘要）

## API 配置

| 字段 | 默认值 | 说明 |
|------|--------|------|
| API Endpoint | `https://api.deepseek.com/v1` | OpenAI 兼容接口地址 |
| Model | `deepseek-chat` | 可按提供商文档更换 |
| API Key | （用户填写） | 本地加密存储，**切勿提交到 Git** |

支持 DeepSeek 等 OpenAI 兼容端点；密钥仅存本机，不进仓库。
