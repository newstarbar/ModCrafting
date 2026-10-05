// @ts-nocheck
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import StatusBar from '../components/StatusBar'
import { buildContextAttribution } from '../utils/context-attribution'
import type { UsageStats } from '../utils/usage'

const LONG_TOOL_OUTPUT = `mixins.json 注册清单 ${'X'.repeat(400)} 结束`

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

  it('falls back to a single fill bar when no attribution exists', () => {
    const { container } = render(
      <StatusBar usage={BASE_USAGE} running={false} attribution={null} />
    )
    expect(container.querySelector('.statusbar-context-bar__fill')).toBeInTheDocument()
    expect(container.querySelector('.statusbar-context-seg')).not.toBeInTheDocument()
  })

  it('renders a segmented bar sized to actual window occupancy', () => {
    const attribution = buildContextAttribution(
      [
        { role: 'system', content: 'ModCrafting AI 助手\n'.repeat(30) },
        { role: 'user', origin: 'user', content: '将潜影贝的飞弹攻击替换为苦力怕' },
        { role: 'tool', name: 'submit_plan', content: LONG_TOOL_OUTPUT },
        { role: 'assistant', content: LONG_TOOL_OUTPUT }
      ],
      { promptTokens: 40_000, windowTokens: 1_000_000 }
    )
    const { container } = render(
      <StatusBar
        usage={{ ...BASE_USAGE, contextPercent: 4, lastPromptTokens: 40_000, attribution }}
        running={false}
        attribution={attribution}
      />
    )

    expect(container.querySelector('.statusbar-context-bar__fill')).not.toBeInTheDocument()
    expect(container.querySelectorAll('.statusbar-context-seg').length)
      .toEqual(attribution.categories.length)
    // The stack must occupy only the used slice of the window, otherwise the
    // bar silently stops reporting "how full is the context".
    expect(container.querySelector('.statusbar-context-segments'))
      .toHaveStyle({ width: '4%' })
    // Unaccounted tokens are real but unexplained, so they render last.
    expect(attribution.categories[attribution.categories.length - 1].category).toBe('unaccounted')
    expect(container.querySelector('.statusbar-context-dup')).toBeInTheDocument()
    expect(container.querySelector('.statusbar-context[aria-label="上下文占用归因"]'))
      .toHaveAttribute('aria-expanded', 'false')
    expect(container.firstChild).toMatchSnapshot()
  })

  it('opens the portalled popover on click and closes it on Escape', () => {
    const attribution = buildContextAttribution(
      [{ role: 'system', content: 'sys' }, { role: 'tool', name: 'grep', content: LONG_TOOL_OUTPUT }],
      { promptTokens: 9_000, windowTokens: 1_000_000 }
    )
    const { container, unmount } = render(
      <StatusBar usage={BASE_USAGE} running={false} attribution={attribution} />
    )

    // The status bar clips overflow, so the popover must live outside it.
    expect(container.querySelector('.context-breakdown')).not.toBeInTheDocument()
    fireEvent.click(container.querySelector('.statusbar-context'))
    expect(document.body.querySelector('.context-breakdown')).toBeInTheDocument()
    expect(container.querySelector('.statusbar-context')).toHaveAttribute('aria-expanded', 'true')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.body.querySelector('.context-breakdown')).not.toBeInTheDocument()

    fireEvent.click(container.querySelector('.statusbar-context'))
    unmount()
    expect(document.body.querySelector('.context-breakdown')).not.toBeInTheDocument()
  })

  it('stays non-interactive when no attribution exists', () => {
    const { container } = render(<StatusBar usage={BASE_USAGE} running={false} />)
    const context = container.querySelector('.statusbar-context')

    expect(context).not.toHaveAttribute('role')
    expect(context).not.toHaveAttribute('aria-label')
    fireEvent.click(context)
    expect(document.body.querySelector('.context-breakdown')).not.toBeInTheDocument()
  })
})
