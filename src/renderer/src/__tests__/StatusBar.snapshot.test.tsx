// @ts-nocheck
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import StatusBar from '../components/StatusBar'
import type { UsageStats } from '../utils/usage'

// Mock the deep dependency chain (shared llm-providers & context-compact)
vi.mock('../utils/usage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/usage')>()
  return {
    ...actual,
    contextWindowLimit: () => 128_000,
    workingContextWindow: () => 128_000,
    formatContextLimit: (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
  }
})

const BASE_USAGE: UsageStats = {
  sessionTokens: 15200,
  turnTokens: 800,
  cacheHitTokens: 5000,
  cacheMissTokens: 2000,
  turnCacheHitTokens: 300,
  turnCacheMissTokens: 100,
  turns: 3,
  contextPercent: 12,
  lastPromptTokens: 15200,
  cost: 0.0234
}

describe('StatusBar', () => {
  it('renders idle state with minimal usage', () => {
    const { container } = render(
      <StatusBar usage={BASE_USAGE} running={false} />
    )
    expect(container.firstChild).toMatchSnapshot()
  })

  it('renders running state with provider label', () => {
    const { container } = render(
      <StatusBar
        usage={BASE_USAGE}
        running
        providerLabel="DeepSeek"
        modelId="deepseek-flash"
        providerId="deepseek"
      />
    )
    expect(container.firstChild).toMatchSnapshot()
  })

  it('renders with toolchain ready', () => {
    const { container } = render(
      <StatusBar
        usage={BASE_USAGE}
        running={false}
        toolchain={{ jdk: 'ready', gradle: 'ready', deps: 'ready' }}
      />
    )
    expect(container.firstChild).toMatchSnapshot()
  })

  it('renders with toolchain initializing (percent)', () => {
    const { container } = render(
      <StatusBar
        usage={BASE_USAGE}
        running={false}
        toolchain={{ jdk: 'pending', gradle: 'pending', deps: 'pending' }}
        toolchainPercent={67}
      />
    )
    expect(container.firstChild).toMatchSnapshot()
  })

  it('renders with project versions and MC runtime', () => {
    const { container } = render(
      <StatusBar
        usage={BASE_USAGE}
        running
        projectVersions={{ mc: '1.21.4', fabricLoader: '0.16.10', fabricApi: '0.114.0' }}
        mcRuntime={{ kind: 'game', variant: 'playing', label: '游戏中', failed: false }}
      />
    )
    expect(container.firstChild).toMatchSnapshot()
  })

  it('renders with high context usage (danger zone)', () => {
    const highUsage: UsageStats = { ...BASE_USAGE, contextPercent: 85 }
    const { container } = render(
      <StatusBar usage={highUsage} running={false} />
    )
    const contextBar = container.querySelector('.statusbar-context-bar--danger')
    expect(contextBar).toBeInTheDocument()
  })

  it('renders with deepseek balance label', () => {
    const { container } = render(
      <StatusBar
        usage={BASE_USAGE}
        running={false}
        deepseekBalanceLabel="￥110.00"
      />
    )
    expect(container.firstChild).toMatchSnapshot()
  })

  it('shows correct status text for running vs idle', () => {
    const { getByText: getByTextRunning } = render(
      <StatusBar usage={BASE_USAGE} running />
    )
    expect(getByTextRunning('运行中')).toBeInTheDocument()

    const { getByText: getByTextIdle } = render(
      <StatusBar usage={BASE_USAGE} running={false} />
    )
    expect(getByTextIdle('就绪')).toBeInTheDocument()
  })
})
