import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownContentProps {
  content: string
  className?: string
}

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const match = /language-([\w-]+)/.exec(className || '')
  const lang = match?.[1] || '代码'
  const text = String(children ?? '').replace(/\n$/, '')
  return (
    <div className="code-block-wrapper">
      <div className="code-block-header"><span>{lang}</span></div>
      <pre className="code-block"><code className={className}>{text}</code></pre>
    </div>
  )
}

const MarkdownContent: React.FC<MarkdownContentProps> = ({ content, className }) => {
  if (!content) return null

  return (
    <div className={className ? `markdown-body ${className}` : 'markdown-body'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            return <>{children}</>
          },
          code({ className, children, ...props }) {
            const text = String(children ?? '')
            const isBlock = Boolean(className) || text.includes('\n')
            if (!isBlock) {
              return <code className="inline-code" {...props}>{children}</code>
            }
            return <CodeBlock className={className}>{children}</CodeBlock>
          },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            )
          },
          table({ children }) {
            return <div className="markdown-table-wrap"><table>{children}</table></div>
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

export default MarkdownContent
