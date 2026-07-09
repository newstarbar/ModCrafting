import type { Controller } from '../harness/controller'
import type { ComposerMode } from '../harness/turn-intent'
import type { ActivePlan, DisplayMessage, FileSnapshot, SessionStateSnapshot } from '../types/display-message'

export interface TurnFileChange {
	path: string
	oldContent?: string
	action?: 'create' | 'update' | 'delete'
}

export function buildPreTurnSnapshot(opts: {
	messageIndex: number
	controller: Controller | null
	composerMode: ComposerMode
	sessionGoal: string
	activePlan: ActivePlan | null
}): SessionStateSnapshot {
	const ctrl = opts.controller
	return {
		messageIndex: opts.messageIndex,
		controllerMessages: ctrl?.getSnapshot() ?? [],
		phase: ctrl?.phase ?? 'plan',
		composerMode: opts.composerMode,
		sessionGoal: opts.sessionGoal,
		activePlan: opts.activePlan
			? { ...opts.activePlan, steps: [...opts.activePlan.steps] }
			: undefined,
		fileSnapshots: [],
	}
}

export function fileChangesToSnapshots(changes: TurnFileChange[]): FileSnapshot[] {
	const byPath = new Map<string, FileSnapshot>()
	for (const change of changes) {
		if (!change.path) continue
		const isCreate = change.action === 'create'
		byPath.set(change.path, {
			path: change.path,
			content: isCreate ? '' : (change.oldContent ?? ''),
			timestamp: Date.now(),
		})
	}
	return [...byPath.values()]
}

export function mergeFileSnapshotsInto(
	existing: FileSnapshot[],
	changes: TurnFileChange[],
): FileSnapshot[] {
	const byPath = new Map(existing.map((f) => [f.path, f]))
	for (const snap of fileChangesToSnapshots(changes)) {
		byPath.set(snap.path, snap)
	}
	return [...byPath.values()]
}

/** Find the user message that started the turn ending at assistantMsgId. */
export function findTurnUserMessageIndex(messages: DisplayMessage[], assistantMsgId: string): number {
	const anchorIdx = messages.findIndex((m) => m.id === assistantMsgId)
	if (anchorIdx < 0) return -1
	if (anchorIdx > 0 && messages[anchorIdx - 1]?.role === 'user') {
		return anchorIdx - 1
	}
	for (let i = anchorIdx - 1; i >= 0; i--) {
		if (messages[i].role === 'user') return i
	}
	return -1
}

export function applyFileChangesToUserSnapshot(
	messages: DisplayMessage[],
	assistantMsgId: string,
	changes: TurnFileChange[],
): DisplayMessage[] {
	if (changes.length === 0) return messages
	const userIdx = findTurnUserMessageIndex(messages, assistantMsgId)
	if (userIdx < 0) return messages

	const userMsg = messages[userIdx]
	if (!userMsg.stateSnapshot) return messages

	const next = [...messages]
	next[userIdx] = {
		...userMsg,
		stateSnapshot: {
			...userMsg.stateSnapshot,
			fileSnapshots: mergeFileSnapshotsInto(userMsg.stateSnapshot.fileSnapshots, changes),
		},
	}
	return next
}

export function enrichUserSnapshotAfterTurnDone(
	messages: DisplayMessage[],
	assistantMsgId: string,
	changes: TurnFileChange[],
	enrich: Partial<Pick<SessionStateSnapshot, 'planTrackerSteps' | 'phase' | 'activePlan'>>,
): DisplayMessage[] {
	const userIdx = findTurnUserMessageIndex(messages, assistantMsgId)
	if (userIdx < 0) return messages

	const userMsg = messages[userIdx]
	if (!userMsg.stateSnapshot) return messages

	const next = [...messages]
	next[userIdx] = {
		...userMsg,
		stateSnapshot: {
			...userMsg.stateSnapshot,
			...enrich,
			fileSnapshots: changes.length > 0
				? mergeFileSnapshotsInto(userMsg.stateSnapshot.fileSnapshots, changes)
				: userMsg.stateSnapshot.fileSnapshots,
		},
	}
	return next
}
