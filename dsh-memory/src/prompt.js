/** System-prompt guidance injected once per request. */

export const MEMORY_SECTION = {
  name: 'tool:memory',
  text:
    'memory_save 分两种用途：AGENTS.md 约定的调用用来保存关于自己的记忆，tags 必须包含自己的名字；其余 memory_save 只记录任务记忆'+
    '任务结束（成功或失败）后调用一次 memory_save：写清做了什么、关键操作流程、结果；较长原文放 detail。' +
    '开始可能重复的工作前先 memory_recall（只返回摘要），摘要不足再用 memory_open 取详细记忆。' +
    '一个任务一条，不要当日记。记忆没有删除或修改接口。',
}