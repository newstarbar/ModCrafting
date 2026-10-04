import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import TaskPlan from '../components/TaskPlan'
import type { PlanStep } from '../components/TaskPlan'

const SAMPLE_STEPS: PlanStep[] = [
  { id: '1', description: '创建方块注册类 `ObsidianLampBlock`', status: 'completed', kind: 'write', targetPath: 'src/main/ObsidianLampBlock.java' },
  { id: '2', description: '在 `ModInit` 中注册方块与物品', status: 'running', kind: 'write', targetPath: 'src/main/ModInit.java' },
  { id: '3', description: '添加合成配方（workbench shaped）', status: 'pending', kind: 'recipe' },
  { id: '4', description: '构建并运行 GameTest 验证', status: 'pending', kind: 'game_test' }
]

const ALL_DONE_STEPS: PlanStep[] = [
  { id: '1', description: '创建物品注册', status: 'completed', kind: 'write' },
  { id: '2', description: '添加模型文件', status: 'completed', kind: 'write' }
]

const ERROR_STEPS: PlanStep[] = [
  { id: '1', description: '创建方块注册类', status: 'completed', kind: 'write' },
  { id: '2', description: '编译失败：缺少导入', status: 'error', kind: 'write' },
  { id: '3', description: '添加合成配方', status: 'pending', kind: 'recipe' }
]

describe('TaskPlan', () => {
  it('renders null when steps is empty', () => {
    const { container } = render(<TaskPlan steps={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders expanded plan with mixed statuses (pinned variant)', () => {
    const { container } = render(<TaskPlan steps={SAMPLE_STEPS} variant="pinned" />)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('renders collapsed plan (anchored variant)', () => {
    const { container } = render(
      <TaskPlan steps={SAMPLE_STEPS} variant="anchored" defaultCollapsed />
    )
    expect(container.firstChild).toMatchSnapshot()
  })

  it('renders all-completed state', () => {
    const { container } = render(<TaskPlan steps={ALL_DONE_STEPS} />)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('renders error state', () => {
    const { container } = render(<TaskPlan steps={ERROR_STEPS} />)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('shows correct status labels', () => {
    const { getByText, getAllByText, container } = render(<TaskPlan steps={SAMPLE_STEPS} />)
    // Running tag is visible in the active section
    expect(getByText('进行中')).toBeInTheDocument()
    // Two pending steps → use getAllByText
    expect(getAllByText('待办')).toHaveLength(2)
    // Completed steps are in the collapsed "已完成" section
    const doneToggle = container.querySelector('.task-plan-section-toggle')
    expect(doneToggle?.textContent).toContain('已完成')
  })

  it('renders step descriptions', () => {
    const { container } = render(<TaskPlan steps={SAMPLE_STEPS} />)
    // Active step descriptions are rendered in the DOM
    const stepTexts = container.querySelectorAll('.task-plan-step-text')
    expect(stepTexts.length).toBeGreaterThanOrEqual(3)
    expect(stepTexts[0].textContent).toContain('ModInit')
    expect(stepTexts[1].textContent).toContain('添加合成配方')
  })
})
