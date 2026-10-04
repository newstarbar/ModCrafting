import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionRuntimeManager, SessionRuntime } from '../../src/renderer/src/harness/session-runtime.ts'
import type { ChatSession } from '../../src/renderer/src/types/chat.ts'
import { Registry } from '../../src/renderer/src/harness/tools.ts'

test('SessionRuntimeManager creates and manages isolated runtimes', () => {
  const manager = SessionRuntimeManager.getInstance()
  const apiConfig = { endpoint: 'http://mock.api', apiKey: 'sk-test', model: 'mock-model', providerId: 'mock' }

  const runtimeA = manager.getOrCreateRuntime({
    sessionId: 'test-session-a',
    projectPath: '/test/proj1',
    apiConfig
  })

  const runtimeB = manager.getOrCreateRuntime({
    sessionId: 'test-session-b',
    projectPath: '/test/proj1',
    apiConfig
  })

  assert.notEqual(runtimeA, runtimeB)
  assert.equal(runtimeA.sessionId, 'test-session-a')
  assert.equal(runtimeB.sessionId, 'test-session-b')
  assert.equal(manager.getRuntime('test-session-a'), runtimeA)
  assert.equal(manager.getRuntime('test-session-b'), runtimeB)
})

test('Concurrent Ask and Plan modes across multiple sessions do not conflict', () => {
  const manager = SessionRuntimeManager.getInstance()
  const apiConfig = { endpoint: 'http://mock.api', apiKey: 'sk-test', model: 'mock-model', providerId: 'mock' }

  const runtime1 = manager.getOrCreateRuntime({
    sessionId: 'test-session-ask-1',
    projectPath: '/test/proj1',
    apiConfig
  })
  runtime1.setComposerMode('ask')
  runtime1.isLoading = true

  const runtime2 = manager.getOrCreateRuntime({
    sessionId: 'test-session-plan-1',
    projectPath: '/test/proj1',
    apiConfig
  })
  runtime2.setComposerMode('plan')
  runtime2.isLoading = true

  // Asking whether another agent is running in proj1
  const check = manager.hasRunningAgentSession('/test/proj1', 'test-session-plan-1')
  // Neither is in 'agent' mode, so hasRunningAgentSession returns false
  assert.equal(check.running, false)

  runtime1.isLoading = false
  runtime2.isLoading = false
})

test('hasRunningAgentSession detects Agent mode concurrency within the same project', () => {
  const manager = SessionRuntimeManager.getInstance()
  const apiConfig = { endpoint: 'http://mock.api', apiKey: 'sk-test', model: 'mock-model', providerId: 'mock' }

  const runtimeAgent = manager.getOrCreateRuntime({
    sessionId: 'test-session-agent-1',
    projectPath: '/test/proj-alpha',
    apiConfig
  })
  runtimeAgent.setComposerMode('agent')
  runtimeAgent.isLoading = true

  // Another session in the same project checks for running agent
  const checkSameProj = manager.hasRunningAgentSession('/test/proj-alpha', 'test-session-agent-2')
  assert.equal(checkSameProj.running, true)
  assert.equal(checkSameProj.sessionId, 'test-session-agent-1')

  // The running session itself checking should not conflict with itself
  const checkSelf = manager.hasRunningAgentSession('/test/proj-alpha', 'test-session-agent-1')
  assert.equal(checkSelf.running, false)

  // A session in a DIFFERENT project should not conflict
  const checkDifferentProj = manager.hasRunningAgentSession('/test/proj-beta', 'test-session-beta-1')
  assert.equal(checkDifferentProj.running, false)

  runtimeAgent.isLoading = false
})

test('SessionRuntime subscribe receives initial snapshot and updates, unsubscribe detaches listener', () => {
  const manager = SessionRuntimeManager.getInstance()
  const apiConfig = { endpoint: 'http://mock.api', apiKey: 'sk-test', model: 'mock-model', providerId: 'mock' }

  const runtime = manager.getOrCreateRuntime({
    sessionId: 'test-session-sub-1',
    projectPath: '/test/proj1',
    apiConfig
  })

  let receivedSnapshots = 0
  let lastComposerMode = ''

  const unsubscribe = runtime.subscribe((snapshot) => {
    receivedSnapshots++
    lastComposerMode = snapshot.composerMode
  })

  // Initial snapshot received immediately on subscribe
  assert.equal(receivedSnapshots, 1)
  assert.equal(lastComposerMode, 'agent')

  // Mutation triggers notification
  runtime.setComposerMode('plan')
  assert.equal(receivedSnapshots, 2)
  assert.equal(lastComposerMode, 'plan')

  // Unsubscribe stops listener
  unsubscribe()
  runtime.setComposerMode('ask')
  assert.equal(receivedSnapshots, 2) // No new snapshot received
  assert.equal(runtime.composerMode, 'ask') // Runtime state still updated in background
})

test('SessionRuntime hydrateFromSession correctly restores persisted messages and state', () => {
  const manager = SessionRuntimeManager.getInstance()
  const apiConfig = { endpoint: 'http://mock.api', apiKey: 'sk-test', model: 'mock-model', providerId: 'mock' }

  const runtime = manager.getOrCreateRuntime({
    sessionId: 'test-session-hydrate',
    projectPath: '/test/proj1',
    apiConfig
  })

  const mockSession: ChatSession = {
    id: 'test-session-hydrate',
    name: '测试会话',
    composerMode: 'plan',
    sessionGoal: '重构组件',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [
      {
        role: 'user',
        content: '分析当前项目',
        timestamp: 1000
      },
      {
        role: 'assistant',
        content: '这是分析结果',
        timestamp: 2000,
        turnStatus: 'answered'
      }
    ]
  }

  runtime.hydrateFromSession(mockSession, async () => ({ ok: false }))

  assert.equal(runtime.composerMode, 'plan')
  assert.equal(runtime.sessionGoal, '重构组件')
  assert.equal(runtime.displayMessages.length, 2)
  assert.equal(runtime.displayMessages[0].role, 'user')
  assert.equal(runtime.displayMessages[0].content, '分析当前项目')
  assert.equal(runtime.displayMessages[1].role, 'assistant')
})

test('SessionRuntimeManager destroyRuntime cleans up runtime and triggers global notifications', () => {
  const manager = SessionRuntimeManager.getInstance()
  const apiConfig = { endpoint: 'http://mock.api', apiKey: 'sk-test', model: 'mock-model', providerId: 'mock' }

  const runtime = manager.getOrCreateRuntime({
    sessionId: 'test-session-destroy',
    projectPath: '/test/proj1',
    apiConfig
  })

  let globalNotified = false
  const unsubscribeGlobal = manager.subscribeGlobal((evt) => {
    if (evt.sessionId === 'test-session-destroy') {
      globalNotified = true
    }
  })

  manager.destroyRuntime('test-session-destroy')
  assert.equal(manager.getRuntime('test-session-destroy'), undefined)
  assert.equal(globalNotified, true)

  unsubscribeGlobal()
})
