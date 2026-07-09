import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

interface McFloatingTooltipProps {
  title: string
  lines?: string[]
  children: React.ReactNode
  placement?: 'above' | 'below'
}

export const McFloatingTooltip: React.FC<McFloatingTooltipProps> = ({
  title,
  lines,
  children,
  placement = 'below',
}) => {
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const anchorRef = useRef<HTMLSpanElement>(null)

  const updatePosition = useCallback(() => {
    const el = anchorRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({
      left: rect.left + rect.width / 2,
      top: placement === 'below' ? rect.bottom + 4 : rect.top - 4,
    })
  }, [placement])

  const show = () => {
    updatePosition()
    setVisible(true)
  }

  const hide = () => setVisible(false)

  useEffect(() => {
    if (!visible) return
    const onReposition = () => updatePosition()
    window.addEventListener('scroll', onReposition, true)
    window.addEventListener('resize', onReposition)
    return () => {
      window.removeEventListener('scroll', onReposition, true)
      window.removeEventListener('resize', onReposition)
    }
  }, [visible, updatePosition])

  return (
    <>
      <span
        ref={anchorRef}
        className="mc-floating-tooltip-anchor"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </span>
      {visible &&
        createPortal(
          <div
            className={`mc-floating-tooltip mc-tooltip mc-tooltip--${placement}`}
            role="tooltip"
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              transform:
                placement === 'below' ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
            }}
          >
            <span className="mc-tooltip-title">{title}</span>
            {lines?.map((line, i) => (
              <span key={i} className="mc-tooltip-line">
                {line}
              </span>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}

export default McFloatingTooltip
