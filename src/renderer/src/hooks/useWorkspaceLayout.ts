import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'

export const ACTIVITY_BAR_WIDTH = 48
export const LEFT_MIN = 180
export const LEFT_MAX = 420
export const LEFT_DEFAULT = 240
export const RIGHT_MIN = 260
export const RIGHT_MAX = 520
export const RIGHT_DEFAULT = 360
export const MAIN_MIN = 320
export const RESIZE_HANDLE_WIDTH = 5

const STORAGE_KEY = 'modcrafting-workspace-layout'

interface LayoutPersist {
	leftWidth: number
	rightWidth: number
	leftCollapsed: boolean
	rightCollapsed: boolean
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value))
}

function loadLayout(): LayoutPersist {
	try {
		const raw = localStorage.getItem(STORAGE_KEY)
		if (!raw) {
			return {
				leftWidth: LEFT_DEFAULT,
				rightWidth: RIGHT_DEFAULT,
				leftCollapsed: false,
				rightCollapsed: false,
			}
		}
		const parsed = JSON.parse(raw) as Partial<LayoutPersist>
		return {
			leftWidth: clamp(Number(parsed.leftWidth) || LEFT_DEFAULT, LEFT_MIN, LEFT_MAX),
			rightWidth: clamp(Number(parsed.rightWidth) || RIGHT_DEFAULT, RIGHT_MIN, RIGHT_MAX),
			leftCollapsed: Boolean(parsed.leftCollapsed),
			rightCollapsed: Boolean(parsed.rightCollapsed),
		}
	} catch {
		return {
			leftWidth: LEFT_DEFAULT,
			rightWidth: RIGHT_DEFAULT,
			leftCollapsed: false,
			rightCollapsed: false,
		}
	}
}

function saveLayout(layout: LayoutPersist): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
	} catch {
		/* ignore quota */
	}
}

export function useWorkspaceLayout() {
	const initial = useRef(loadLayout())
	const [leftWidth, setLeftWidth] = useState(initial.current.leftWidth)
	const [rightWidth, setRightWidth] = useState(initial.current.rightWidth)
	const [leftCollapsed, setLeftCollapsed] = useState(initial.current.leftCollapsed)
	const [rightCollapsed, setRightCollapsed] = useState(initial.current.rightCollapsed)
	const [isResizing, setIsResizing] = useState(false)

	const layoutRef = useRef<HTMLDivElement | null>(null)
	const persistTimerRef = useRef<number | null>(null)
	const dragRef = useRef<{
		side: 'left' | 'right'
		startX: number
		startWidth: number
	} | null>(null)

	const schedulePersist = useCallback((
		next: Partial<LayoutPersist> & { leftWidth: number; rightWidth: number; leftCollapsed: boolean; rightCollapsed: boolean },
	) => {
		if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current)
		persistTimerRef.current = window.setTimeout(() => {
			saveLayout({
				leftWidth: next.leftWidth,
				rightWidth: next.rightWidth,
				leftCollapsed: next.leftCollapsed,
				rightCollapsed: next.rightCollapsed,
			})
		}, 200)
	}, [])

	const getMaxLeftWidth = useCallback((currentRightWidth: number, rightIsCollapsed: boolean) => {
		const layoutWidth = layoutRef.current?.clientWidth ?? 1200
		const rightOccupied = rightIsCollapsed ? 0 : currentRightWidth
		const handles = rightIsCollapsed ? RESIZE_HANDLE_WIDTH : RESIZE_HANDLE_WIDTH * 2
		return clamp(
			layoutWidth - ACTIVITY_BAR_WIDTH - rightOccupied - handles - MAIN_MIN,
			LEFT_MIN,
			LEFT_MAX,
		)
	}, [])

	const getMaxRightWidth = useCallback((currentLeftWidth: number, leftIsCollapsed: boolean) => {
		const layoutWidth = layoutRef.current?.clientWidth ?? 1200
		const leftOccupied = ACTIVITY_BAR_WIDTH + (leftIsCollapsed ? 0 : currentLeftWidth)
		const handles = leftIsCollapsed ? RESIZE_HANDLE_WIDTH : RESIZE_HANDLE_WIDTH * 2
		return clamp(
			layoutWidth - leftOccupied - handles - MAIN_MIN,
			RIGHT_MIN,
			RIGHT_MAX,
		)
	}, [])

	const toggleLeftCollapsed = useCallback((collapsed?: boolean) => {
		setLeftCollapsed((prev) => {
			const next = collapsed ?? !prev
			schedulePersist({ leftWidth, rightWidth, leftCollapsed: next, rightCollapsed })
			return next
		})
	}, [leftWidth, rightWidth, rightCollapsed, schedulePersist])

	const toggleRightCollapsed = useCallback((collapsed?: boolean) => {
		setRightCollapsed((prev) => {
			const next = collapsed ?? !prev
			schedulePersist({ leftWidth, rightWidth, leftCollapsed, rightCollapsed: next })
			return next
		})
	}, [leftWidth, rightWidth, leftCollapsed, schedulePersist])

	const beginLeftResize = useCallback((clientX: number) => {
		dragRef.current = { side: 'left', startX: clientX, startWidth: leftWidth }
		setIsResizing(true)
	}, [leftWidth])

	const beginRightResize = useCallback((clientX: number) => {
		dragRef.current = { side: 'right', startX: clientX, startWidth: rightWidth }
		setIsResizing(true)
	}, [rightWidth])

	useEffect(() => {
		const onPointerMove = (e: PointerEvent) => {
			const drag = dragRef.current
			if (!drag) return

			if (drag.side === 'left') {
				const maxLeft = getMaxLeftWidth(rightWidth, rightCollapsed)
				const next = clamp(drag.startWidth + (e.clientX - drag.startX), LEFT_MIN, maxLeft)
				setLeftWidth(next)
				return
			}

			const maxRight = getMaxRightWidth(leftWidth, leftCollapsed)
			const next = clamp(drag.startWidth - (e.clientX - drag.startX), RIGHT_MIN, maxRight)
			setRightWidth(next)
		}

		const onPointerUp = () => {
			if (!dragRef.current) return
			dragRef.current = null
			setIsResizing(false)
			setLeftWidth((lw) => {
				setRightWidth((rw) => {
					setLeftCollapsed((lc) => {
						setRightCollapsed((rc) => {
							schedulePersist({
								leftWidth: lw,
								rightWidth: rw,
								leftCollapsed: lc,
								rightCollapsed: rc,
							})
							return rc
						})
						return lc
					})
					return rw
				})
				return lw
			})
		}

		window.addEventListener('pointermove', onPointerMove)
		window.addEventListener('pointerup', onPointerUp)
		window.addEventListener('pointercancel', onPointerUp)
		return () => {
			window.removeEventListener('pointermove', onPointerMove)
			window.removeEventListener('pointerup', onPointerUp)
			window.removeEventListener('pointercancel', onPointerUp)
		}
	}, [getMaxLeftWidth, getMaxRightWidth, leftCollapsed, leftWidth, rightCollapsed, rightWidth, schedulePersist])

	useEffect(() => () => {
		if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current)
	}, [])

	const layoutStyle = {
		'--sidebar-panel-width': leftCollapsed ? '0px' : `${leftWidth}px`,
		'--sidebar-width': `calc(${ACTIVITY_BAR_WIDTH}px + ${leftCollapsed ? 0 : leftWidth}px)`,
		'--right-panel-width': rightCollapsed ? '0px' : `${rightWidth}px`,
	} as CSSProperties

	return {
		layoutRef,
		layoutStyle,
		leftWidth,
		rightWidth,
		leftCollapsed,
		rightCollapsed,
		isResizing,
		toggleLeftCollapsed,
		toggleRightCollapsed,
		beginLeftResize,
		beginRightResize,
	}
}
