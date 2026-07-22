import React from 'react'
import type { ChronoEntryTool } from '../types/display-message.ts'
import type { ExploreGroupKind } from '../utils/tool-explore-group.ts'
import { summarizeExploreGroup } from '../utils/tool-explore-group.ts'
import { extractPreview } from '../utils/tool-output-preview.ts'
import { KnowledgeHitTags, hasKnowledgeHitTags } from './KnowledgeHitTags.tsx'

const TOOL_SHORT_NAMES: Record<string, string> = {
  read_file: '读取',
  list_directory: '目录',
  grep: '搜索',
  fabric_docs_search: '文档',
  fabric_javadoc_lookup: 'JavaDoc',
  vanilla_mc_wiki_query: 'Wiki'
}

function getToolShortName(name: string): string {
  return TOOL_SHORT_NAMES[name] || name
}

function pathLabel(tool: ChronoEntryTool): string | undefined {
  if (tool.name === 'grep') {
    const pattern = String(tool.args?.pattern || '').trim()
    if (!pattern) return undefined
    return pattern.length > 28 ? `${pattern.slice(0, 28)}…` : pattern
  }
  const raw = tool.args?.path ?? tool.args?.keyword ?? tool.args?.query
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  return raw.split('/').pop() || raw
}

export interface ToolExploreGroupProps {
  kind: ExploreGroupKind
  groupKey: string
  tools: ChronoEntryTool[]
  reasoningCount?: number
  collapsed: boolean
  collapsedToolIds: Set<string>
  runTick: number
  onToggleGroup: (key: string) => void
  onToggleTool: (id: string) => void
  getToolDisplayName: (name: string, args?: Record<string, unknown>) => string
}

const ToolExploreGroup: React.FC<ToolExploreGroupProps> = ({
  kind,
  groupKey,
  tools,
  reasoningCount = 0,
  collapsed,
  collapsedToolIds,
  runTick,
  onToggleGroup,
  onToggleTool,
  getToolDisplayName
}) => {
  void runTick
  const summary = summarizeExploreGroup(kind, tools, reasoningCount)
  const statusClass = summary.aggregateStatus
  const showGroupTags = kind === 'knowledge' && hasKnowledgeHitTags(summary.knowledgeHitOutput)

  return (
    <div className={`tool-explore-group tool-explore-group--${kind}${summary.hasRunning ? ' running' : ''}`}>
      <button
        type="button"
        className="tool-explore-group-hd"
        onClick={() => onToggleGroup(groupKey)}
      >
        <span className="tool-explore-group-icon">{collapsed ? '▸' : '▾'}</span>
        <span className={`tool-status-dot ${statusClass}`} />
        <span className="tool-explore-group-title">{summary.title}</span>
        <span className="tool-explore-group-badge">{summary.countLabel}</span>
        {collapsed && (
          <>
            <span className="tool-explore-group-stats">{summary.statsLine}</span>
            {summary.thoughtHint && (
              <span className="tool-explore-group-thought">{summary.thoughtHint}</span>
            )}
            {showGroupTags ? (
              <KnowledgeHitTags output={summary.knowledgeHitOutput} className="kh-hit-tags--inline" maxTrails={2} />
            ) : (
              summary.pathPreview && (
                <span className="tool-explore-group-preview" title={summary.pathPreview}>
                  {summary.pathPreview}
                </span>
              )
            )}
          </>
        )}
      </button>

      {!collapsed && (
        <div className="tool-explore-group-bd">
          {tools.map((tool) => {
            const displayOutput = tool.liveOutput || tool.output
            const isChildCollapsed = collapsedToolIds.has(tool.id)
            const path = pathLabel(tool)
            const elapsedSec = tool.startMs && tool.status === 'running'
              ? Math.max(1, Math.floor((Date.now() - tool.startMs) / 1000))
              : null
            const useTags = Boolean(displayOutput && hasKnowledgeHitTags(displayOutput))
            const preview = displayOutput
              ? extractPreview(tool.name, displayOutput, tool.args)
              : path || getToolShortName(tool.name)

            return (
              <div
                key={tool.id}
                className={`tool-explore-item${tool.status === 'running' ? ' running' : ''}`}
              >
                <span className={`tool-status-dot ${tool.status === 'done' ? 'done' : tool.status === 'running' ? 'running' : tool.status === 'error' ? 'error' : 'pending'}`} />
                <span className="tool-explore-item-name">{getToolShortName(tool.name)}</span>
                {path && (
                  <span className="tool-explore-item-path" title={String(tool.args?.path || tool.args?.pattern || tool.args?.keyword || '')}>
                    {path}
                  </span>
                )}
                {useTags ? (
                  <KnowledgeHitTags output={displayOutput || ''} className="kh-hit-tags--inline" maxTrails={2} />
                ) : (
                  <span className="tool-explore-item-preview" title={displayOutput || preview}>
                    {preview}
                  </span>
                )}
                {tool.durationMs != null && (
                  <span className="tool-explore-item-meta">
                    {tool.durationMs >= 1000 ? `${(tool.durationMs / 1000).toFixed(1)}s` : `${tool.durationMs}ms`}
                  </span>
                )}
                {elapsedSec != null && (
                  <span className="tool-explore-item-meta">({elapsedSec}s)</span>
                )}
                {displayOutput && (
                  <button
                    type="button"
                    className="tool-explore-item-toggle"
                    onClick={() => onToggleTool(tool.id)}
                  >
                    {isChildCollapsed ? '展开' : '收起'}
                  </button>
                )}
                {displayOutput && !isChildCollapsed && (
                  <div className="tool-line-output tool-explore-item-output">
                    {hasKnowledgeHitTags(displayOutput) && (
                      <div className="kh-hit-tags-block">
                        <KnowledgeHitTags output={displayOutput} maxTrails={4} />
                      </div>
                    )}
                    <pre className={tool.status === 'error' ? 'is-error' : undefined}>{displayOutput}</pre>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default ToolExploreGroup
