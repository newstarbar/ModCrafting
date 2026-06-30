import React, { useRef, useEffect } from 'react'

interface FileViewerProps {
  fileName: string
  content: string
}

const FileViewer: React.FC<FileViewerProps> = ({ fileName, content }) => {
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = 0
    }
  }, [fileName, content])

  const ext = fileName.split('.').pop()?.toLowerCase()
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'bmp'].includes(ext || '')

  // Simple syntax highlighting for common file types
  const highlightCode = (code: string, lang: string): string => {
    // Escape HTML
    let escaped = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')

    if (lang === 'java') {
      // Keywords
      const keywords = ['package', 'import', 'public', 'private', 'protected', 'class', 'interface', 'extends', 'implements', 'static', 'final', 'void', 'int', 'String', 'boolean', 'float', 'double', 'long', 'new', 'return', 'if', 'else', 'for', 'while', 'do', 'try', 'catch', 'finally', 'throw', 'throws', 'this', 'super', 'null', 'true', 'false', 'var', 'record', 'sealed', 'permits', 'instanceof']
      const keywordPattern = new RegExp(`\\b(${keywords.join('|')})\\b`, 'g')
      escaped = escaped.replace(keywordPattern, '<span style="color:#c678dd">$1</span>')

      // Annotations
      escaped = escaped.replace(/@\w+/g, '<span style="color:#e5c07b">$&</span>')

      // Strings
      escaped = escaped.replace(/"((?:[^"\\]|\\.)*)"/g, '<span style="color:#98c379">"$1"</span>')

      // Comments
      escaped = escaped.replace(/\/\/.*$/gm, '<span style="color:#5c6370">$&</span>')
      escaped = escaped.replace(/\/\*[\s\S]*?\*\//g, '<span style="color:#5c6370">$&</span>')

      // Numbers
      escaped = escaped.replace(/\b(\d+\.?\d*)\b/g, '<span style="color:#d19a66">$1</span>')
    } else if (lang === 'json') {
      // Keys
      escaped = escaped.replace(/"([^"]+)":/g, '<span style="color:#61afef">"$1"</span>:')
      // String values
      escaped = escaped.replace(/:\s*"((?:[^"\\]|\\.)*)"/g, ': <span style="color:#98c379">"$1"</span>')
      // Numbers/booleans
      escaped = escaped.replace(/\b(true|false|null)\b/g, '<span style="color:#d19a66">$1</span>')
      escaped = escaped.replace(/: (\d+)/g, ': <span style="color:#d19a66">$1</span>')
    } else if (lang === 'gradle') {
      const keywords = ['plugins', 'id', 'version', 'repositories', 'dependencies', 'implementation', 'modImplementation', 'include', 'minecraft', 'mappings', 'loom', 'sourceSets', 'processResources', 'tasks', 'java', 'publishing', 'publications']
      const keywordPattern = new RegExp(`\\b(${keywords.join('|')})\\b`, 'g')
      escaped = escaped.replace(keywordPattern, '<span style="color:#c678dd">$1</span>')
      escaped = escaped.replace(/'.*?'/g, '<span style="color:#98c379">$&</span>')
      escaped = escaped.replace(/"((?:[^"\\]|\\.)*)"/g, '<span style="color:#98c379">"$1"</span>')
    }

    return escaped
  }

  if (isImage) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          padding: '16px',
          background: 'var(--bg-tertiary)'
        }}
      >
        <span style={{ color: 'var(--text-muted)' }}>
          图像预览暂不支持嵌入。文件: {fileName}
        </span>
      </div>
    )
  }

  const lang = ext === 'java' ? 'java' : ext === 'json' ? 'json' : ext === 'gradle' || ext === 'kts' ? 'gradle' : ''

  return (
    <pre
      ref={preRef}
      style={{
        margin: 0,
        padding: '16px',
        height: '100%',
        overflow: 'auto',
        fontFamily: 'var(--font-mono)',
        fontSize: '13px',
        lineHeight: '1.6',
        background: 'var(--bg-tertiary)',
        color: 'var(--text-primary)',
        tabSize: 4,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all'
      }}
      dangerouslySetInnerHTML={{
        __html: highlightCode(content, lang)
      }}
    />
  )
}

export default FileViewer
