import { getApiKey } from './api-config'

export interface DeepSeekBalanceInfo {
  currency: string
  totalBalance: string
  grantedBalance: string
  toppedUpBalance: string
}

export interface DeepSeekBalanceResult {
  success: boolean
  isAvailable?: boolean
  balances?: DeepSeekBalanceInfo[]
  /** Preferred CNY total if present, else first currency. */
  displayCurrency?: string
  displayTotal?: string
  error?: string
}

function pickPreferred(balances: DeepSeekBalanceInfo[]): DeepSeekBalanceInfo | undefined {
  return balances.find((b) => b.currency === 'CNY')
    ?? balances.find((b) => b.currency === 'USD')
    ?? balances[0]
}

/** GET https://api.deepseek.com/user/balance */
export async function fetchDeepSeekBalance(apiKeyOverride?: string): Promise<DeepSeekBalanceResult> {
  let apiKey = apiKeyOverride?.trim() || ''
  if (!apiKey) {
    const stored = getApiKey('deepseek')
    if (!stored.success || !stored.apiKey?.trim()) {
      return { success: false, error: stored.error || '未找到 DeepSeek API Key，请先在设置中保存密钥' }
    }
    apiKey = stored.apiKey.trim()
  }

  try {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      }
    })
    const text = await res.text()
    if (!res.ok) {
      let detail = text.slice(0, 200)
      try {
        const errJson = JSON.parse(text) as { error?: { message?: string }; message?: string }
        detail = errJson.error?.message || errJson.message || detail
      } catch {
        /* keep raw */
      }
      return { success: false, error: `查询失败 (${res.status}): ${detail}` }
    }

    const data = JSON.parse(text) as {
      is_available?: boolean
      balance_infos?: Array<{
        currency?: string
        total_balance?: string
        granted_balance?: string
        topped_up_balance?: string
      }>
    }

    const balances: DeepSeekBalanceInfo[] = (data.balance_infos || [])
      .filter((b) => b && typeof b.currency === 'string')
      .map((b) => ({
        currency: String(b.currency),
        totalBalance: String(b.total_balance ?? '0'),
        grantedBalance: String(b.granted_balance ?? '0'),
        toppedUpBalance: String(b.topped_up_balance ?? '0')
      }))

    const preferred = pickPreferred(balances)
    return {
      success: true,
      isAvailable: Boolean(data.is_available),
      balances,
      displayCurrency: preferred?.currency,
      displayTotal: preferred?.totalBalance,
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
