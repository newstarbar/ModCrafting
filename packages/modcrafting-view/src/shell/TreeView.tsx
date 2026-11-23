import React from 'react'

export interface TreeNode {
  id: string
  label: string
  children?: TreeNode[]
  /** Short right-aligned marker: a count, a problem badge, a state. */
  badge?: string
  tone?: 'error' | 'muted'
  hint?: string
}

/**
 * Recursive tree with native disclosure.
 *
 * Uses `<details>` instead of managed open-state so expansion survives the 1.8s
 * state poll without the shell having to remember it.
 */
export function TreeView({ nodes, selectedId, onSelect, empty }: {
  nodes: TreeNode[]
  selectedId?: string
  onSelect: (id: string) => void
  empty?: string
}) {
  if (nodes.length === 0) return <p className="muted tree-empty">{empty ?? '没有内容'}</p>
  return <ul className="tree" role="tree">
    {nodes.map((node) => <TreeItem key={node.id} node={node} depth={0} selectedId={selectedId} onSelect={onSelect} />)}
  </ul>
}

function TreeItem({ node, depth, selectedId, onSelect }: {
  node: TreeNode
  depth: number
  selectedId?: string
  onSelect: (id: string) => void
}) {
  const className = [
    'tree-row',
    node.id === selectedId ? 'selected' : '',
    node.tone ? `tone-${node.tone}` : ''
  ].filter(Boolean).join(' ')
  const padding = { paddingLeft: 8 + depth * 12 }

  if (!node.children?.length) {
    return <li role="treeitem" aria-selected={node.id === selectedId}>
      <button type="button" className={className} style={padding} title={node.hint} onClick={() => onSelect(node.id)}>
        <span className="tree-label">{node.label}</span>
        {node.badge && <span className="tree-badge">{node.badge}</span>}
      </button>
    </li>
  }

  return <li role="treeitem" aria-expanded>
    <details open>
      <summary className="tree-row tree-group" style={padding}>
        <span className="tree-label">{node.label}</span>
        {node.badge && <span className="tree-badge">{node.badge}</span>}
      </summary>
      <ul className="tree" role="group">
        {node.children.map((child) => <TreeItem key={child.id} node={child} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} />)}
      </ul>
    </details>
  </li>
}
