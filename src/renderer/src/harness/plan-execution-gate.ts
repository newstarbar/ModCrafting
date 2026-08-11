export function planRequiresStructuredGameTest(planText: string): boolean {
  return /(?:\.java\b|src\/(?:main|client)\/resources|\bmixin\b|配方|物品|方块|实体|玩家|交互|hud|gui|minecraft|fabric)/i.test(planText)
}

export function containsStructuredGameTest(planText: string): boolean {
  return /"gameTest"\s*:\s*\{\s*"version"\s*:\s*2\b/i.test(planText) &&
    /"acceptanceContract"\s*:\s*\{\s*"version"\s*:\s*1\b/i.test(planText)
}

export function structuredGameTestGate(planText: string): { ok: true } | { ok: false; error: string } {
  if (!planRequiresStructuredGameTest(planText) || containsStructuredGameTest(planText)) return { ok: true }
  return {
    ok: false,
    error: '涉及 Minecraft/Fabric 游戏代码的计划必须来自成功的 submit_plan，并携带完整 V2 gameTest 与 AcceptanceContract；编号文字或 Markdown 计划不能直接进入执行阶段。'
  }
}
