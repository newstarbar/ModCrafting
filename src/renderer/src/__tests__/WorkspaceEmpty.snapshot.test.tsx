import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import WorkspaceEmpty from '../components/WorkspaceEmpty'

describe('WorkspaceEmpty', () => {
  it('renders default empty state', () => {
    const { container } = render(
      <WorkspaceEmpty
        onGoHub={vi.fn()}
        onOpenProject={vi.fn()}
        onNewProject={vi.fn()}
      />
    )
    expect(container.firstChild).toMatchSnapshot()
  })

  it('renders all three action buttons', () => {
    const { getByText } = render(
      <WorkspaceEmpty
        onGoHub={vi.fn()}
        onOpenProject={vi.fn()}
        onNewProject={vi.fn()}
      />
    )
    expect(getByText('新建项目')).toBeInTheDocument()
    expect(getByText('打开项目')).toBeInTheDocument()
    expect(getByText('返回首页')).toBeInTheDocument()
  })
})
