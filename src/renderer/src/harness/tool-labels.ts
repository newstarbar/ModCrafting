/** Chinese labels for tool chips / system prompt. Keep API `name` in English. */

export const TOOL_LABELS_ZH: Record<string, string> = {
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  grep: '搜索源码',
  delete_file: '删除文件',
  list_directory: '列出目录',
  run_command: '运行命令',
  trigger_build: '触发构建',
  create_recipe: '创建配方',
  read_error_log: '读取错误日志',
  complete_step: '完成步骤',
  fabric_docs_search: '搜索文档',
  fabric_javadoc_lookup: '查询 JavaDoc',
  vanilla_mc_wiki_query: '查询 Wiki',
  fabric_meta_version_check: '检查版本',
  fabric_mod_json_validate: '验证 mod.json',
  fabric_recipe_generate: '生成配方',
  fabric_recipe_validate: '校验配方',
  fabric_content_register: '注册内容',
  fabric_data_assets_generate: '生成资源',
  fabric_mixin_target_lookup: '查询 Mixin 目标',
  fabric_mixin_scaffold: '生成 Mixin',
  fabric_mixin_register: '注册 Mixin',
  fabric_mixin_validate: '校验 Mixin',
  fabric_log_debugger: '分析日志',
  explain_code: '解释代码',
  list_templates: '列出模板',
  fabric_template_generate: '生成模板',
  submit_plan: '提交计划',
  ask_clarification: '向用户提问',
  mc_screenshot: '游戏截图',
  mc_inspect: '游戏内检视',
  mc_inventory: '查看背包',
  mc_world: '查看附近世界',
  mc_chat: '游戏聊天',
  mc_command: '执行游戏命令',
  mc_input: '游戏输入'
}

export function getToolLabelZh(name: string, args?: Record<string, unknown>): string {
  if (name === 'trigger_build' && args) {
    const task = String(args.task || '')
    if (task === 'runClient') return '游戏测试'
    if (task === 'build') return '构建编译'
    if (task === 'runServer') return '启动服务端'
    if (task === 'runDatagen') return '数据生成'
    if (task === 'test') return '运行测试'
    return '触发构建'
  }
  if (name === 'mc_input' && args) {
    const action = String(args.action || '').toLowerCase()
    const key = String(args.key || '').trim()
    const label = String(args.label || args.message || '').trim()
    if (action === 'key_press' || action === 'key_down' || action === 'key_up') {
      return key ? `游戏按键 ${key.toUpperCase()}` : '游戏按键'
    }
    if (action === 'click_widget') {
      return label ? `点击控件「${label.slice(0, 16)}」` : '点击界面控件'
    }
    if (action === 'click_at') return '点击界面坐标'
    if (action === 'mouse_click') return '鼠标点击'
    if (action === 'mouse_move') return '转动视角'
    if (action === 'scroll') return '滚轮滚动'
    if (action) return `游戏输入·${action}`
  }
  if (name === 'mc_chat' && args) {
    const msg = String(args.message || '').trim()
    if (msg.startsWith('/')) return '发送游戏命令'
    if (msg) return '发送聊天'
  }
  return TOOL_LABELS_ZH[name] || name
}
