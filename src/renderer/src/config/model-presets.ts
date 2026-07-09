import { LLM_PROVIDERS, type LlmModelDef } from '../../../shared/llm-providers.ts'

export interface ModelPreset {
  id: string
  label: string
  providerId: string
}

export const MODEL_PRESETS: ModelPreset[] = LLM_PROVIDERS.flatMap((provider) =>
  provider.models.map((model: LlmModelDef) => ({
    id: model.id,
    label: model.label,
    providerId: provider.id,
  }))
)

export { modelDisplayLabel, isKnownModel } from '../../../shared/llm-providers.ts'
