import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import UpdateBanner from '../components/UpdateBanner'

describe('UpdateBanner', () => {
  it('renders nothing when visible is false', () => {
    const { container } = render(
      <UpdateBanner visible={false} message="更新中" percent={50} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders banner with message and progress when visible', () => {
    const { container } = render(
      <UpdateBanner visible message="正在下载更新…" percent={42} />
    )
    expect(container.firstChild).toMatchSnapshot()
  })

  it('clamps progress bar width to 100%', () => {
    const { container } = render(
      <UpdateBanner visible message="完成" percent={150} />
    )
    expect(container.firstChild).toMatchSnapshot()
  })

  it('renders at 0% progress', () => {
    const { container } = render(
      <UpdateBanner visible message="准备中" percent={0} />
    )
    expect(container.firstChild).toMatchSnapshot()
  })
})
