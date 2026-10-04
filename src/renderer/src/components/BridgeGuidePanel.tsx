import React from 'react'
import { getToolLabelZh } from '../harness/tool-labels'

type BridgeCapabilityGroup = {
  title: string
  hint: string
  items: Array<{ name: string; summary: string }>
}

const BRIDGE_GROUPS: BridgeCapabilityGroup[] = [
  {
    title: '环境与就绪',
    hint: '启动客户端后先确认 Observer 桥接就绪，再进入测试世界。',
    items: [
      {
        name: 'mc_runtime_status',
        summary: '读取目标模组、已加载模组、Observer V2 与桥接失败原因；桥接异常时优先诊断。'
      },
      {
        name: 'mc_ensure_test_world',
        summary: '确保进入专用测试世界；停在主菜单不算功能验证通过。'
      },
      {
        name: 'mc_ensure_cheats',
        summary: '确保测试世界具备作弊/命令权限，便于后续命令与场景编排。'
      }
    ]
  },
  {
    title: '观测（只读）',
    hint: 'Observer 采集通用游戏状态；缺少能力只能判 INCONCLUSIVE，不能靠截图硬过。',
    items: [
      {
        name: 'mc_screenshot',
        summary: '截取当前画面；非视觉模型请配合检视工具做数据化验证。'
      },
      {
        name: 'mc_inspect',
        summary: '一次检视玩家、当前界面、控件与准星；仅 TitleScreen 不算验证完成。'
      },
      {
        name: 'mc_inventory',
        summary: '读取快捷栏、主背包、盔甲与副手。'
      },
      {
        name: 'mc_world',
        summary: '列出附近实体并采样周围方块。'
      },
      {
        name: 'mc_observe_entity',
        summary: '观察实体 AI、速度、爆炸倒计时等；实体行为修改必须用此对比状态。'
      }
    ]
  },
  {
    title: '操控',
    hint: '通过桥接在游戏内执行命令与输入，用于布置场景与触发功能。',
    items: [
      {
        name: 'mc_command',
        summary: '在服务端线程执行命令并返回真实结果。'
      },
      {
        name: 'mc_input',
        summary: '键盘、鼠标、点击控件/坐标等游戏输入。'
      },
      {
        name: 'mc_chat',
        summary: '发送聊天或斜杠命令。'
      }
    ]
  },
  {
    title: '确定性测试',
    hint: 'Arrange → Act → Assert；只有结构化断言 PASS 才算通过。',
    items: [
      {
        name: 'mc_test_scenario',
        summary: '按功能类型生成测试场景模板/规格（物品、方块、配方、实体、交互、HUD）。'
      },
      {
        name: 'mc_run_test',
        summary: '执行 V2 确定性测试会话；环境或证据不足返回 INCONCLUSIVE。'
      }
    ]
  }
]

const BridgeGuidePanel: React.FC = () => {
  return (
    <div className="bridge-guide-panel">
      <div className="bridge-guide-intro">
        <strong>Observer 测试桥接</strong>
        <p className="mc-dim">
          随游戏启动的观测模组，为 AI 提供截图、检视、命令与确定性验收能力。
          配置开关请到设置 → 工具与 MCP。
        </p>
      </div>

      {BRIDGE_GROUPS.map((group) => (
        <section key={group.title} className="bridge-guide-group">
          <h3 className="bridge-guide-group-title">{group.title}</h3>
          <p className="bridge-guide-group-hint mc-dim">{group.hint}</p>
          <ul className="bridge-guide-list">
            {group.items.map((item) => (
              <li key={item.name} className="bridge-guide-item">
                <div className="bridge-guide-item-head">
                  <span className="bridge-guide-item-label">{getToolLabelZh(item.name)}</span>
                  <code className="bridge-guide-item-name">{item.name}</code>
                </div>
                <p className="bridge-guide-item-summary">{item.summary}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

export default BridgeGuidePanel
