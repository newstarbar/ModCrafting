import React, { useState } from 'react'
import {
  IconAlertTriangle,
  IconCode,
  IconHammer,
  IconLink,
  IconCopy,
  IconX,
  IconSquare,
  IconPackage
} from './Icon'
import type { ContextTagType } from '../context/context-ingress'

export interface ContextChipData {
  id: string
  type: ContextTagType
  label: string
  text: string
}

const CHIP_ICONS: Record<ContextTagType, React.FC<{ size?: 'sm' | 'md' | 'lg' }>> = {
  crash: IconAlertTriangle,
  'code-explain': IconCode,
  'build-error': IconHammer,
  shortcut: IconLink,
  'runtime-error': IconAlertTriangle,
  'quick-create': IconPackage,
  generic: IconSquare
}

const CHIP_LABELS: Record<ContextTagType, string> = {
  crash: '崩溃报告',
  'code-explain': '代码解释',
  'build-error': '构建报错',
  shortcut: '快捷内容',
  'runtime-error': '运行时错误',
  'quick-create': '快捷创建',
  generic: '上下文'
}

export function getChipLabel(type: ContextTagType, customLabel?: string): string {
  return customLabel || CHIP_LABELS[type] || '上下文'
}

interface ContextChipProps {
  chip: ContextChipData
  onRemove: (id: string) => void
}

const ContextChip: React.FC<ContextChipProps> = ({ chip, onRemove }) => {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const Icon = CHIP_ICONS[chip.type] || IconSquare

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(chip.text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation()
    onRemove(chip.id)
  }

  return (
    <div className={`context-chip context-chip--${chip.type}`}>
      <button
        type="button"
        className="context-chip__body"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? '点击收起' : '点击查看完整内容'}
      >
        <Icon size="sm" />
        <span className="context-chip__label">{chip.label}</span>
      </button>
      <button
        type="button"
        className="context-chip__copy"
        onClick={handleCopy}
        title={copied ? '已复制' : '复制内容'}
      >
        <IconCopy size="sm" />
      </button>
      <button
        type="button"
        className="context-chip__remove"
        onClick={handleRemove}
        title="移除"
      >
        <IconX size="sm" />
      </button>
      {expanded && (
        <div className="context-chip__popover" onClick={(e) => e.stopPropagation()}>
          <div className="context-chip__popover-header">
            <span>{chip.label}</span>
            <button
              type="button"
              className="context-chip__popover-close"
              onClick={() => setExpanded(false)}
            >
              <IconX size="sm" />
            </button>
          </div>
          <pre className="context-chip__text">{chip.text}</pre>
        </div>
      )}
      {copied && <span className="context-chip__toast">已复制</span>}
    </div>
  )
}

interface ContextChipListProps {
  chips: ContextChipData[]
  onRemove: (id: string) => void
}

export const ContextChipList: React.FC<ContextChipListProps> = ({ chips, onRemove }) => {
  if (chips.length === 0) return null
  return (
    <div className="chat-composer__chips">
      {chips.map((chip) => (
        <ContextChip key={chip.id} chip={chip} onRemove={onRemove} />
      ))}
    </div>
  )
}

export default ContextChip
