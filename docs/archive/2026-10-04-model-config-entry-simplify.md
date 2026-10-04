# 2026-10-04：模型配置入口收敛（4→2）

## 背景

模型相关配置曾分散在侧栏 API 表单、设置中心「模型服务 / 路由 / 预设」、以及输入区庞大菜单（策略 + 任务模板 + 全厂商模型），日常切换成本高。对照 Continue / LibreChat / Open WebUI 的分层做法，保留自定义能力，收敛信息架构。

## 完成内容

- `ComposerModelMenu`：策略优先（快速/均衡/深度 + 更多），固定模型仅列已保存 Key 的厂商；去掉任务模板；页脚「管理模型连接…」「高级路由…」。
- `SettingsCenter`：导航合并为「模型」单页（连接 + 默认策略卡片 + 高级折叠）；数据目录/更新/关于迁入对应分区；首启未完成 onboarding 时提示并展开策略。
- `SessionSidebar`：退役 settings Tab 与重复 API 表单；齿轮只打开设置中心。
- `App` / `ChatPanel` / `ChatComposer`：`settingsFocus` 支持定位到模型页高级区；传入 `savedProviderIds` 过滤未连接厂商。

## 维护约定

- 连接与密钥只允许在设置中心「模型 → 连接」编辑。
- 输入区不得再增加 Endpoint/Key 编辑控件。
- 角色绑定、导入导出预设继续放在「高级路由」折叠区。
