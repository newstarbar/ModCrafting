import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  IconPlus,
  IconFolder,
  IconFile,
  IconSettings,
  IconSend,
  IconX,
  IconCode,
  IconPlay,
  IconGhost,
  IconAlertTriangle
} from '../components/Icon'

const ICONS = {
  IconPlus,
  IconFolder,
  IconFile,
  IconSettings,
  IconSend,
  IconX,
  IconCode,
  IconPlay,
  IconGhost,
  IconAlertTriangle
}

describe('Icon components', () => {
  for (const [name, Icon] of Object.entries(ICONS)) {
    it(`${name} renders correctly (default size)`, () => {
      const { container } = render(<Icon />)
      expect(container.firstChild).toMatchSnapshot()
    })
  }

  it('IconPlus renders with sm size class', () => {
    const { container } = render(<IconPlus size="sm" />)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('IconPlus renders with lg size class', () => {
    const { container } = render(<IconPlus size="lg" />)
    expect(container.firstChild).toMatchSnapshot()
  })

  it('IconPlus accepts custom className', () => {
    const { container } = render(<IconPlus className="custom-class" />)
    const svg = container.firstChild as SVGElement
    expect(svg.classList.contains('custom-class')).toBe(true)
  })

  it('all icons have aria-hidden attribute', () => {
    for (const [name, Icon] of Object.entries(ICONS)) {
      const { container } = render(<Icon />)
      const svg = container.firstChild as SVGElement
      expect(svg.getAttribute('aria-hidden')).toBe('true')
    }
  })
})
