import React, { useEffect, useRef, useState, useCallback } from 'react'
import type { ChronoEntryGuiLayout } from '../types/display-message'
import type { GuiLayoutElement } from '../harness/events'

export interface GuiLayoutPreviewPanelProps {
  entry: ChronoEntryGuiLayout
  disabled?: boolean
  onConfirm: (layoutJson: string) => void
  onCancel: () => void
  /** 用户反馈预览与期望不符，要求 AI 根据反馈重新生成 */
  onFeedback?: (feedback: string) => void
}

const CANVAS_WIDTH = 1280
const CANVAS_HEIGHT = 720
const GRID_SIZE = 8
const ALIGN_THRESHOLD = 4

/** Strip <script>...</script> tags and interactive buttons from HTML to prevent AI-injected scripts/actions. */
function stripInteractiveTags(html: string): string {
  // 移除 <script>
  let cleaned = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
  // 移除 <button> 和 <input type="button|submit|reset">
  cleaned = cleaned.replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, '')
  cleaned = cleaned.replace(/<input\b[^>]*type=["']?(button|submit|reset)["']?[^>]*>/gi, '')
  // 移除可能带有 onclick 属性的元素
  cleaned = cleaned.replace(/\s*onclick=["'][^"']*["']/gi, '')
  return cleaned
}

/** Inject the drag + alignment script before </body> (or append if no body tag). */
function injectDragScript(html: string): string {
  const script = `
<script>
(function() {
  'use strict';
  var GRID_SIZE = ${GRID_SIZE};
  var ALIGN_THRESHOLD = ${ALIGN_THRESHOLD};
  var CANVAS_WIDTH = ${CANVAS_WIDTH};
  var CANVAS_HEIGHT = ${CANVAS_HEIGHT};

  var elements = Array.prototype.slice.call(document.querySelectorAll('[data-layout-id]'));
  var guides = [];
  var guideContainer = null;

  function ensureGuideContainer() {
    if (!guideContainer) {
      guideContainer = document.createElement('div');
      guideContainer.style.cssText = 'position:absolute;top:0;left:0;width:' + CANVAS_WIDTH + 'px;height:' + CANVAS_HEIGHT + 'px;pointer-events:none;z-index:9999;';
      document.body.appendChild(guideContainer);
    }
    return guideContainer;
  }

  function clearGuides() {
    if (guideContainer) {
      while (guideContainer.firstChild) guideContainer.removeChild(guideContainer.firstChild);
    }
  }

  function showGuide(x1, y1, x2, y2, isVertical) {
    var line = document.createElement('div');
    if (isVertical) {
      line.style.cssText = 'position:absolute;left:' + x1 + 'px;top:' + Math.min(y1, y2) + 'px;width:1px;height:' + Math.abs(y2 - y1) + 'px;background:rgba(0,255,0,0.6);';
    } else {
      line.style.cssText = 'position:absolute;top:' + y1 + 'px;left:' + Math.min(x1, x2) + 'px;height:1px;width:' + Math.abs(x2 - x1) + 'px;background:rgba(0,255,0,0.6);';
    }
    ensureGuideContainer().appendChild(line);
  }

  function getElementBounds(el) {
    var left = parseInt(el.style.left) || 0;
    var top = parseInt(el.style.top) || 0;
    var width = parseInt(el.style.width) || el.offsetWidth || 100;
    var height = parseInt(el.style.height) || el.offsetHeight || 20;
    return { left: left, top: top, width: width, height: height, right: left + width, bottom: top + height, centerX: left + width / 2, centerY: top + height / 2 };
  }

  function snapToGrid(val) {
    return Math.round(val / GRID_SIZE) * GRID_SIZE;
  }

  function findAlignment(activeBounds, activeEl) {
    var snappedX = activeBounds.left;
    var snappedY = activeBounds.top;
    var aligned = false;

    for (var i = 0; i < elements.length; i++) {
      var other = elements[i];
      if (other === activeEl) continue;
      var ob = getElementBounds(other);

      var activeEdges = [
        { type: 'left', val: activeBounds.left },
        { type: 'right', val: activeBounds.right },
        { type: 'centerX', val: activeBounds.centerX }
      ];
      var otherEdges = [
        { type: 'left', val: ob.left },
        { type: 'right', val: ob.right },
        { type: 'centerX', val: ob.centerX }
      ];

      for (var ae = 0; ae < activeEdges.length; ae++) {
        for (var oe = 0; oe < otherEdges.length; oe++) {
          if (Math.abs(activeEdges[ae].val - otherEdges[oe].val) < ALIGN_THRESHOLD) {
            var diff = otherEdges[oe].val - activeEdges[ae].val;
            if (activeEdges[ae].type === 'left') snappedX = ob[otherEdges[oe].type === 'left' ? 'left' : otherEdges[oe].type === 'right' ? 'right' : 'centerX'] - 0;
            else if (activeEdges[ae].type === 'right') snappedX = (otherEdges[oe].type === 'left' ? ob.left : otherEdges[oe].type === 'right' ? ob.right : ob.centerX) - activeBounds.width;
            else snappedX = (otherEdges[oe].type === 'left' ? ob.left : otherEdges[oe].type === 'right' ? ob.right : ob.centerX) - activeBounds.width / 2;
            snappedX = snapToGrid(snappedX);
            aligned = true;
            showGuide(otherEdges[oe].val, Math.min(activeBounds.top, ob.top), otherEdges[oe].val, Math.max(activeBounds.bottom, ob.bottom), true);
            break;
          }
        }
      }

      var activeYEdges = [
        { type: 'top', val: activeBounds.top },
        { type: 'bottom', val: activeBounds.bottom },
        { type: 'centerY', val: activeBounds.centerY }
      ];
      var otherYEdges = [
        { type: 'top', val: ob.top },
        { type: 'bottom', val: ob.bottom },
        { type: 'centerY', val: ob.centerY }
      ];

      for (var ay = 0; ay < activeYEdges.length; ay++) {
        for (var oy = 0; oy < otherYEdges.length; oy++) {
          if (Math.abs(activeYEdges[ay].val - otherYEdges[oy].val) < ALIGN_THRESHOLD) {
            if (activeYEdges[ay].type === 'top') snappedY = otherYEdges[oy].type === 'top' ? ob.top : otherYEdges[oy].type === 'bottom' ? ob.bottom : ob.centerY;
            else if (activeYEdges[ay].type === 'bottom') snappedY = (otherYEdges[oy].type === 'top' ? ob.top : otherYEdges[oy].type === 'bottom' ? ob.bottom : ob.centerY) - activeBounds.height;
            else snappedY = (otherYEdges[oy].type === 'top' ? ob.top : otherYEdges[oy].type === 'bottom' ? ob.bottom : ob.centerY) - activeBounds.height / 2;
            snappedY = snapToGrid(snappedY);
            aligned = true;
            showGuide(Math.min(activeBounds.left, ob.left), otherYEdges[oy].val, Math.max(activeBounds.right, ob.right), otherYEdges[oy].val, false);
            break;
          }
        }
      }
    }
    return { x: snappedX, y: snappedY, aligned: aligned };
  }

  var activeEl = null;
  var startX, startY, origLeft, origTop;

  function onMouseDown(e) {
    var target = e.target;
    while (target && !target.hasAttribute('data-layout-id')) {
      target = target.parentElement;
    }
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    activeEl = target;
    var bounds = getElementBounds(activeEl);
    startX = e.clientX;
    startY = e.clientY;
    origLeft = bounds.left;
    origTop = bounds.top;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e) {
    if (!activeEl) return;
    e.preventDefault();
    var dx = e.clientX - startX;
    var dy = e.clientY - startY;
    var newLeft = snapToGrid(origLeft + dx);
    var newTop = snapToGrid(origTop + dy);
    newLeft = Math.max(0, Math.min(newLeft, CANVAS_WIDTH - parseInt(activeEl.style.width) || 100));
    newTop = Math.max(0, Math.min(newTop, CANVAS_HEIGHT - parseInt(activeEl.style.height) || 20));

    var bounds = getElementBounds(activeEl);
    bounds.left = newLeft;
    bounds.top = newTop;
    bounds.right = newLeft + bounds.width;
    bounds.bottom = newTop + bounds.height;
    bounds.centerX = newLeft + bounds.width / 2;
    bounds.centerY = newTop + bounds.height / 2;

    clearGuides();
    var alignResult = findAlignment(bounds, activeEl);
    if (alignResult.aligned) {
      newLeft = alignResult.x;
      newTop = alignResult.y;
    }

    activeEl.style.left = newLeft + 'px';
    activeEl.style.top = newTop + 'px';

    window.parent.postMessage({
      type: 'gui-layout-update',
      elements: elements.map(function(el) {
        var b = getElementBounds(el);
        return { id: el.getAttribute('data-layout-id'), x: b.left, y: b.top, width: b.width, height: b.height };
      })
    }, '*');
  }

  function onMouseUp() {
    activeEl = null;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    clearGuides();
  }

  function collectElements() {
    return elements.map(function(el) {
      var b = getElementBounds(el);
      return { id: el.getAttribute('data-layout-id'), x: b.left, y: b.top, width: b.width, height: b.height };
    });
  }

  elements.forEach(function(el) {
    el.addEventListener('mousedown', onMouseDown);
    el.style.cursor = 'move';
    el.style.userSelect = 'none';
  });

  window.addEventListener('message', function(e) {
    if (!e.data) return;
    if (e.data.type === 'gui-layout-getdata') {
      window.parent.postMessage({
        type: 'gui-layout-data',
        elements: collectElements()
      }, '*');
    }
  });

  window.addEventListener('beforeunload', function() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  });
})();
<\/script>`

  if (html.includes('</body>')) {
    return html.replace('</body>', script + '\n</body>')
  }
  return html + script
}

const GuiLayoutPreviewPanel: React.FC<GuiLayoutPreviewPanelProps> = ({
  entry,
  disabled = false,
  onConfirm,
  onCancel,
  onFeedback
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [scale, setScale] = useState(1)
  const [currentElements, setCurrentElements] = useState<GuiLayoutElement[]>(entry.elements)
  const [feedbackMode, setFeedbackMode] = useState(false)
  const [feedbackText, setFeedbackText] = useState('')
  const isResolved = entry.status === 'confirmed' || entry.status === 'cancelled'

  /** Build the iframe srcDoc: strip AI scripts/buttons, inject drag script, add base styles for visibility. */
  const buildSrcDoc = useCallback((html: string): string => {
    const cleaned = stripInteractiveTags(html)
    const withScript = injectDragScript(cleaned)
    if (withScript.includes('<html')) {
      return withScript
    }
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body{margin:0;padding:0;overflow:hidden;background:#1e1e1e;font-family:sans-serif;color:#fff;}
      [data-layout-id]{box-sizing:border-box;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.4);padding:4px;min-width:20px;min-height:20px;}
    </style></head><body>${withScript}</body></html>`
  }, [])

  /** Compute scale to fit container width and height. */
  const updateScale = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const availableWidth = container.clientWidth - 32
    const availableHeight = container.clientHeight - 32
    if (availableWidth > 0 && availableHeight > 0) {
      const scaleX = availableWidth / CANVAS_WIDTH
      const scaleY = availableHeight / CANVAS_HEIGHT
      setScale(Math.min(1, scaleX, scaleY))
    }
  }, [])

  useEffect(() => {
    updateScale()
    const handleResize = () => updateScale()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [updateScale])

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return

    setIsLoading(true)
    iframe.srcdoc = buildSrcDoc(entry.html)
    iframe.onload = () => setIsLoading(false)

    const handleMessage = (e: MessageEvent) => {
      if (!e.data) return
      if (e.data.type === 'gui-layout-update' && Array.isArray(e.data.elements)) {
        setCurrentElements(e.data.elements.map((el: { id: string; x: number; y: number; width: number; height: number; color?: number; alpha?: number; shadow?: boolean }) => ({
          id: String(el.id),
          type: 'custom' as const,
          label: '',
          x: Number(el.x) || 0,
          y: Number(el.y) || 0,
          width: Number(el.width) || 100,
          height: Number(el.height) || 20,
          ...(typeof el.color === 'number' ? { color: el.color } : {}),
          ...(typeof el.alpha === 'number' ? { alpha: el.alpha } : {}),
          ...(typeof el.shadow === 'boolean' ? { shadow: el.shadow } : {})
        })))
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [entry.html, buildSrcDoc])

  const handleConfirm = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe || !iframe.contentWindow) return

    const requestData = () => {
      iframe.contentWindow!.postMessage({ type: 'gui-layout-getdata' }, '*')
    }

    const listener = (e: MessageEvent) => {
      if (!e.data) return
      if (e.data.type === 'gui-layout-data' && Array.isArray(e.data.elements)) {
        window.removeEventListener('message', listener)
        const merged: GuiLayoutElement[] = entry.elements.map((orig) => {
          const updated = e.data.elements.find((el: { id: string; x: number; y: number; width: number; height: number; color?: number; alpha?: number; shadow?: boolean }) => el.id === orig.id)
          if (updated) {
            return {
              ...orig,
              x: Number(updated.x) || orig.x,
              y: Number(updated.y) || orig.y,
              width: Number(updated.width) || orig.width,
              height: Number(updated.height) || orig.height,
              ...(typeof updated.color === 'number' ? { color: updated.color } : {}),
              ...(typeof updated.alpha === 'number' ? { alpha: updated.alpha } : {}),
              ...(typeof updated.shadow === 'boolean' ? { shadow: updated.shadow } : {})
            }
          }
          return orig
        })
        const layoutBody = {
          layoutType: entry.layoutType,
          canvasWidth: CANVAS_WIDTH,
          canvasHeight: CANVAS_HEIGHT,
          elements: merged.map((el) => ({
            id: el.id,
            type: el.type,
            label: el.label,
            x: el.x,
            y: el.y,
            width: el.width,
            height: el.height,
            color: typeof el.color === 'number' ? el.color : 0xffffffff,
            alpha: typeof el.alpha === 'number' ? el.alpha : 255,
            shadow: typeof el.shadow === 'boolean' ? el.shadow : true
          }))
        }
        // The approval record is bound to the exact layout JSON so a later
        // GameTestSpec cannot silently substitute a different HUD geometry.
        let hash = 2166136261
        for (const char of JSON.stringify(layoutBody)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
        const layoutJson = JSON.stringify({
          ...layoutBody,
          approvalId: entry.id,
          layoutFingerprint: `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
        }, null, 2)
        onConfirm(layoutJson)
      }
    }

    window.addEventListener('message', listener)
    requestData()

    setTimeout(() => {
      window.removeEventListener('message', listener)
    }, 3000)
  }, [entry, onConfirm])

  const layoutTypeLabel: Record<string, string> = {
    'option-list': '设置列表（SimpleOption + OptionListWidget）',
    'custom-screen': '自定义界面（Screen + 相对坐标）',
    'hud-overlay': 'HUD 覆盖层（HudRenderCallback + 相对坐标）'
  }

  return (
    <div className="gui-layout-preview">
      <div className="gui-layout-preview__header">
        <div className="gui-layout-preview__title">
          <span className="gui-layout-preview__icon" aria-hidden>◻</span>
          <span>{entry.title}</span>
        </div>
        <span className="gui-layout-preview__type-badge">{layoutTypeLabel[entry.layoutType] || entry.layoutType}</span>
      </div>
      <div className="gui-layout-preview__hint">
        拖拽元素调整位置（8px 网格吸附 + 辅助对齐线）。确认后将根据布局 JSON 生成 GUI 代码。
      </div>
      <div className="gui-layout-preview__canvas-wrap" ref={containerRef}>
        {isLoading && <div className="gui-layout-preview__loading">加载预览中...</div>}
        <div
          className="gui-layout-preview__scaler"
          style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, transform: `scale(${scale})`, transformOrigin: 'center center' }}
        >
          <iframe
            ref={iframeRef}
            className="gui-layout-preview__iframe"
            title={entry.title}
            sandbox="allow-scripts allow-same-origin"
            style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, border: 'none', display: isLoading ? 'none' : 'block' }}
          />
        </div>
      </div>
      <div className="gui-layout-preview__footer">
        <div className="gui-layout-preview__element-count">
          {currentElements.length} 个元素
          {entry.status === 'confirmed' && entry.layoutJson ? ' · 已确认' : ''}
          {entry.status === 'cancelled' ? ' · 已取消' : ''}
        </div>
        {!isResolved && !feedbackMode && (
          <div className="gui-layout-preview__actions">
            <button
              type="button"
              className="gui-layout-preview__btn gui-layout-preview__btn--cancel"
              disabled={disabled}
              onClick={onCancel}
            >
              取消
            </button>
            {onFeedback && (
              <button
                type="button"
                className="gui-layout-preview__btn gui-layout-preview__btn--feedback"
                disabled={disabled}
                onClick={() => setFeedbackMode(true)}
              >
                反馈并重新生成
              </button>
            )}
            <button
              type="button"
              className="gui-layout-preview__btn gui-layout-preview__btn--confirm"
              disabled={disabled || isLoading}
              onClick={handleConfirm}
            >
              确认布局
            </button>
          </div>
        )}
        {!isResolved && feedbackMode && (
          <div className="gui-layout-preview__feedback">
            <textarea
              className="gui-layout-preview__feedback-text"
              placeholder="描述预览与期望不符的地方，例如：按钮太大、缺少标题、颜色不对…"
              value={feedbackText}
              disabled={disabled}
              rows={3}
              onChange={(e) => setFeedbackText(e.target.value)}
              autoFocus
            />
            <div className="gui-layout-preview__feedback-actions">
              <button
                type="button"
                className="gui-layout-preview__btn gui-layout-preview__btn--cancel"
                disabled={disabled}
                onClick={() => { setFeedbackMode(false); setFeedbackText('') }}
              >
                返回
              </button>
              <button
                type="button"
                className="gui-layout-preview__btn gui-layout-preview__btn--confirm"
                disabled={disabled || !feedbackText.trim()}
                onClick={() => {
                  onFeedback?.(feedbackText.trim())
                  setFeedbackMode(false)
                  setFeedbackText('')
                }}
              >
                提交反馈
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default GuiLayoutPreviewPanel
