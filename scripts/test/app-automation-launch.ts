export interface AppAutomationLaunchOptions {
  hidden: boolean
  liveProvider: boolean
  profile: string
  discovery: string
  artifacts: string
}

export interface AppAutomationModelSelection {
	providerId: string
	model: string
}

/** Standalone automation is a single-provider regression. Pin every Harness
 * role to the provider under test so an isolated profile never inherits the
 * built-in multi-provider preset and fails before the selected model runs. */
export function appAutomationFixedRoutingConfig(selection: AppAutomationModelSelection) {
	return {
		version: 1 as const,
		onboardingCompleted: true,
		defaultSelection: {
			mode: 'fixed' as const,
			strategyId: 'single',
			taskTemplateId: 'auto' as const,
			model: { providerId: selection.providerId, modelId: selection.model }
		},
		hardLimits: { maxReadonlyConcurrency: 1, maxDelegations: 1, maxExpertRepairHandoffs: 1 },
		presets: []
	}
}

export function isAppAutomationTurnDone(snapshot: Record<string, unknown>): boolean {
	const chat = (snapshot.chat || {}) as Record<string, unknown>
	const controller = (chat.controller || {}) as Record<string, unknown>
	const ui = (chat.ui || {}) as Record<string, unknown>
	if (controller.running !== false || ui.activeAssistantStreaming === true) return false
	const controllerMessages = Array.isArray(controller.messages) ? controller.messages.length : 0
	const uiMessageCount = Number(ui.messageCount || 0)
	return controllerMessages >= 2 || uiMessageCount >= 2
}

export function shouldContinueAppAutomation(snapshot: Record<string, unknown>, continuationCount: number, maximum: number): boolean {
	if (continuationCount >= maximum) return false
	const chat = (snapshot.chat || {}) as Record<string, unknown>
	const controller = (chat.controller || {}) as Record<string, unknown>
	if (controller.running !== false || !Array.isArray(controller.planSteps) || controller.planSteps.length === 0) return false
	return controller.planSteps.some((raw) => {
		const step = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
		return step.status !== 'completed'
	})
}

/** Browser-window visibility is deliberately separate from `windowsHide`: the
 * latter only suppresses the Windows console window. */
export function appAutomationLaunchArgs(options: AppAutomationLaunchOptions): string[] {
  return [
    '.',
    '--automation',
    ...(options.hidden ? ['--automation-hidden'] : []),
    '--automation-profile', options.profile,
    '--automation-discovery', options.discovery,
    '--automation-artifacts', options.artifacts,
    ...(options.liveProvider ? ['--automation-live-provider'] : [])
  ]
}

/** npm 11 may surface a forwarded `--hidden` as npm_config_hidden instead of
 * leaving it in argv. Accept both forms so `npm run test:app -- --hidden`
 * remains a supported compatibility command. */
export function isHiddenAppAutomationMode(argv: readonly string[], env: Record<string, string | undefined>): boolean {
  return argv.includes('--hidden') || env.npm_config_hidden === 'true' || env.npm_config_hidden === ''
}
