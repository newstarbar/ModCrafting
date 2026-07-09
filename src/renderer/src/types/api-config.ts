export interface ApiConfigState {
  endpoint: string
  apiKey: string
  model: string
  providerId: string
}

export type ApiSettingsPayload = Pick<ApiConfigState, 'endpoint' | 'model' | 'providerId'>
