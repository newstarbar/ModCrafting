import React from 'react'
import { createPortal } from 'react-dom'

export interface TooltipAnchor {
  title: string
  left: number
  top: number
}

interface McTooltipLayerProps {
  anchor: TooltipAnchor | null
  placement?: 'above' | 'below'
}

export const McTooltipLayer: React.FC<McTooltipLayerProps> = ({
  anchor,
  placement = 'below',
}) => {
  if (!anchor) return null

  return createPortal(
    <div
      className={`mc-floating-tooltip mc-tooltip mc-tooltip--${placement}`}
      role="tooltip"
      style={{
        position: 'fixed',
        top: anchor.top,
        left: anchor.left,
        transform: placement === 'below' ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
      }}
    >
      <span className="mc-tooltip-title">{anchor.title}</span>
    </div>,
    document.body,
  )
}

export default McTooltipLayer
