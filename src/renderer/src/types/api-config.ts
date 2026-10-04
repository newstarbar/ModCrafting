import type { LlmProtocol } from '../../../shared/harness-runtime.ts'

export interface ApiConfigState {
  endpoint: string
  apiKey: string
  model: string
  providerId: string
  protocol?: LlmProtocol
}

export type ApiSettingsPayload = Pick<ApiConfigState, 'endpoint' | 'model' | 'providerId' | 'protocol'>
