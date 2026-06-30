import React, { useState, useEffect, useCallback } from 'react'
import type { FileEntry } from '../vite-env'

interface FileTreeProps {
  rootPath: string
  selectedFile: string | null
  onSelectFile: (path: string, name: string) => void
}

interface TreeNode extends FileEntry {
  expanded: boolean
  children: TreeNode[]
  loading: boolean
}

const FileTree: React.FC<FileTreeProps> = ({ rootPath, selectedFile, onSelectFile }) => {
  const [tree, setTree] = useState<TreeNode[]>([])

  const loadChildren = useCallback(async (parentPath: string): Promise<TreeNode[]> => {
    const entries = await window.api.listDirectory(parentPath)
    const nodes: TreeNode[] = entries.map((entry) => ({
      ...entry,
      expanded: false,
      children: [],
      loading: false
    }))
    return nodes
  }, [])

  useEffect(() => {
    loadChildren(rootPath).then(setTree)
  }, [rootPath, loadChildren])

  const loadChildrenForNode = useCallback(async (nodePath: string): Promise<TreeNode[]> => {
    const entries = await window.api.listDirectory(nodePath)
    return entries.map((entry) => ({
      ...entry,
      expanded: false,
      children: [],
      loading: false
    }))
  }, [])

  const toggleExpand = useCallback(async (node: TreeNode) => {
    // Don't toggle while already loading
    if (node.loading) return

    // If collapsing, just toggle
    if (node.expanded) {
      setTree((prev) => {
        const update = (nodes: TreeNode[]): TreeNode[] =>
          nodes.map((n) => {
            if (n.path === node.path) return { ...n, expanded: false }
            return { ...n, children: update(n.children) }
          })
        return update(prev)
      })
      return
    }

    // Mark as loading before async fetch
    setTree((prev) => {
      const update = (nodes: TreeNode[]): TreeNode[] =>
        nodes.map((n) => {
          if (n.path === node.path) return { ...n, loading: true }
          return { ...n, children: update(n.children) }
        })
      return update(prev)
    })

    // Lazy-load children
    const children = await loadChildrenForNode(node.path)
    setTree((prev) => {
      const update = (nodes: TreeNode[]): TreeNode[] =>
        nodes.map((n) => {
          if (n.path === node.path) return { ...n, expanded: true, loading: false, children }
          return { ...n, children: update(n.children) }
        })
      return update(prev)
    })
  }, [loadChildrenForNode])

  const renderNode = (node: TreeNode, depth: number = 0): React.ReactNode => {
    const isSelected = selectedFile === node.path
    const isDir = node.isDirectory

    return (
      <React.Fragment key={node.path}>
        <div
          className={`file-tree-item ${isSelected ? 'active' : ''}`}
          style={{ paddingLeft: `${16 + depth * 16}px` }}
          onClick={() => {
            if (isDir) {
              toggleExpand(node)
            } else {
              onSelectFile(node.path, node.name)
            }
          }}
        >
          <span className="icon">
            {isDir ? (node.loading ? '⏳' : node.expanded ? '📂' : '📁') : getFileIcon(node.name)}
          </span>
          <span className="name">{node.name}</span>
        </div>
        {isDir && node.expanded && node.children.map((child) => renderNode(child, depth + 1))}
      </React.Fragment>
    )
  }

  return <>{tree.map((node) => renderNode(node))}</>
}

function getFileIcon(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'java': return '☕'
    case 'json': return '📋'
    case 'gradle':
    case 'kts': return '📦'
    case 'properties': return '⚙️'
    case 'xml': return '📄'
    case 'md': return '📝'
    case 'toml': return '🔧'
    case 'png':
    case 'jpg':
    case 'gif':
    case 'svg': return '🖼️'
    default: return '📄'
  }
}

export default FileTree
