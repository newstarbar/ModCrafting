export interface ModelPreset {
	id: string
	label: string
}

export const MODEL_PRESETS: ModelPreset[] = [
	{ id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
	{ id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
]

export function modelDisplayLabel(modelId: string): string {
	const preset = MODEL_PRESETS.find((p) => p.id === modelId)
	return preset?.label ?? modelId
}
