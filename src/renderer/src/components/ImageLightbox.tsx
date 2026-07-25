import React, { useCallback, useEffect, useState } from 'react'

export interface ImageLightboxProps {
  src: string
  path: string
  name?: string
  onClose: () => void
}

async function blobToPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/png'
    )
  })
}

export async function copyImageToClipboard(dataUrl: string): Promise<boolean> {
  try {
    const res = await fetch(dataUrl)
    const blob = await res.blob()
    const png = await blobToPng(blob)
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    return true
  } catch {
    return false
  }
}

const ImageLightbox: React.FC<ImageLightboxProps> = ({ src, path, name, onClose }) => {
  const [scale, setScale] = useState(1)
  const [toast, setToast] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const flash = useCallback((text: string) => {
    setToast(text)
    window.setTimeout(() => setToast(''), 1800)
  }, [])

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    setScale((s) => Math.min(4, Math.max(0.25, s + (e.deltaY < 0 ? 0.15 : -0.15))))
  }, [])

  const handleCopy = useCallback(async () => {
    const ok = await copyImageToClipboard(src)
    flash(ok ? '已复制图片' : '复制失败')
  }, [src, flash])

  const handleSaveAs = useCallback(async () => {
    const result = await window.api.saveAttachmentAs(path, name)
    if (result.cancelled) return
    flash(result.ok ? '已保存' : (result.error || '保存失败'))
  }, [path, name, flash])

  const handleReveal = useCallback(async () => {
    const result = await window.api.showItemInFolder(path)
    flash(result.success ? '已打开所在文件夹' : (result.error || '打开失败'))
  }, [path, flash])

  return (
    <div className="image-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="image-lightbox__stage" onClick={(e) => e.stopPropagation()} onWheel={onWheel}>
        <img
          className="image-lightbox__img"
          src={src}
          alt={name || '预览'}
          style={{ transform: `scale(${scale})` }}
          draggable={false}
        />
      </div>
      <div className="image-lightbox__toolbar" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={handleCopy}>复制图片</button>
        <button type="button" onClick={handleSaveAs}>另存为</button>
        <button type="button" onClick={handleReveal}>在文件夹中显示</button>
        <button type="button" onClick={onClose}>关闭</button>
      </div>
      {toast ? <div className="image-lightbox__toast">{toast}</div> : null}
    </div>
  )
}

export default ImageLightbox
