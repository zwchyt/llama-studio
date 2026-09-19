// ── 生产执行器：ipc.ts 提取的 handler 直调（registerIpcHandlers 后可用）──
// 注意：本文件依赖 ipc.ts / retrievalService / knowledgeService（间接依赖 electron），
// 只允许在主进程侧使用（workerClient.ts）。utility process 侧的 manager.ts
// 绝不能 import 本文件，否则会把 electron 拖进 worker bundle。
import { ipcInternal } from '../../ipc'
import { handleCodeSearchQuery } from '../retrievalService'
import { queryKnowledgeBase, readKnowledgeChunks, listKnowledgeBases, describeKnowledgeBase } from '../knowledgeService'
import type { MainToolExecutors } from './tools/mainTools'

export function createIpcExecutors(): MainToolExecutors {
  const requireInternal = (name: keyof typeof ipcInternal): void => {
    if (!ipcInternal[name]) throw new Error(`${name} 未注册（registerIpcHandlers 未调用）`)
  }
  return {
    readFile: (filePath, opts) => {
      requireInternal('handleReadFile')
      return ipcInternal.handleReadFile!(filePath, opts)
    },
    writeFile: (filePath, content) => {
      requireInternal('handleWriteFile')
      return ipcInternal.handleWriteFile!(filePath, content)
    },
    glob: (opts) => {
      requireInternal('handleGlob')
      return ipcInternal.handleGlob!(opts)
    },
    listDir: (dirPath) => {
      requireInternal('handleListDir')
      return ipcInternal.handleListDir!(dirPath)
    },
    grep: (opts) => {
      requireInternal('handleGrep')
      return ipcInternal.handleGrep!(opts)
    },
    ripgrep: (opts) => {
      requireInternal('handleRipgrep')
      return ipcInternal.handleRipgrep!(opts)
    },
    deletePath: (path, recursive) => {
      requireInternal('handleDeletePath')
      return ipcInternal.handleDeletePath!(path, recursive)
    },
    todoWrite: (sessionId, input) => {
      requireInternal('handleAgentTodoWrite')
      return ipcInternal.handleAgentTodoWrite!(sessionId, input)
    },
    taskGet: (sessionId, taskId) => {
      requireInternal('handleAgentTaskGet')
      return ipcInternal.handleAgentTaskGet!(sessionId, taskId)
    },
    taskList: (sessionId) => {
      requireInternal('handleAgentTaskList')
      return ipcInternal.handleAgentTaskList!(sessionId)
    },
    codesearchQuery: (dir, query, limit) => handleCodeSearchQuery(dir, query, limit),
    webSearch: (query) => {
      requireInternal('handleWebSearch')
      return ipcInternal.handleWebSearch!(query)
    },
    webSearchBing: (query) => {
      requireInternal('handleWebSearchBing')
      return ipcInternal.handleWebSearchBing!(query)
    },
    fetchWebpage: (url) => {
      requireInternal('handleFetchWebpage')
      return ipcInternal.handleFetchWebpage!(url)
    },
    knowledgeQuery: async (kbId, query, limit) => queryKnowledgeBase(kbId, query, limit),
    knowledgeRead: async (kbId, refs) => readKnowledgeChunks(kbId, refs),
    describeKb: (kbId) => describeKnowledgeBase(kbId),
    listKb: async () => listKnowledgeBases(),
    getPortModelInfo: async (port) => ipcInternal.getPortModelInfo?.(port),
    setAgentWorkspace: async (cwd) => { ipcInternal.handleSetAgentWorkspace?.(cwd) },
    // 默认实现：无窗口通道时由 piAgentIpc 覆写为跨进程弹窗
    askUser: async (questions) =>
      JSON.stringify({
        answers: questions.map((q) => ({ question: q.question, answer: '' })),
        note: '用户不可用，请基于最佳判断继续。'
      }),
    // recordUndo/undo 由 PiAgentManager 构造时包装覆盖（统一管理撤销备份）
    recordUndo: () => {},
    removeUndo: () => {},
    undo: async () => ({ success: false, error: '撤销未启用' })
  }
}
