/** Deterministic, model-free summaries and timestamped transcripts. */

const OUTCOME_RANK = { success: 0, partial: 1, failure: 2 }

const FILE_TOOLS = new Set(['write', 'edit', 'edit_file', 'write_file', 'create_file', 'apply_patch'])
const READ_TOOLS = new Set(['read', 'read_file', 'view', 'open_file'])
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'run_command', 'terminal'])
const SEARCH_TOOLS = new Set(['glob', 'grep', 'search', 'web_search', 'web_fetch'])

export function fmtTime(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`
}

/** Concatenate the text blocks of one message content array. */
export function textOf(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function argsOf(raw) {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function firstArgValue(args) {
  for (const key of ['path', 'command', 'file_path', 'pattern', 'query', 'url', 'name', 'target']) {
    if (typeof args[key] === 'string' && args[key].trim()) return args[key].trim()
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** One human-readable step for a tool call. */
export function toolStep(event) {
  const name = event.data?.name ?? 'tool'
  const args = argsOf(event.data?.arguments)
  const value = firstArgValue(args)
  if (FILE_TOOLS.has(name)) return `修改 ${clip(value, 60)}`
  if (READ_TOOLS.has(name)) return `读取 ${clip(value, 60)}`
  if (SHELL_TOOLS.has(name)) return `运行 ${clip(value.split('\n')[0], 60)}`
  if (SEARCH_TOOLS.has(name)) return `查找 ${clip(value, 60)}`
  return value ? `${name} ${clip(value, 50)}` : name
}

/** Collapse consecutive duplicates and cap the list. */
function compactSteps(steps, max = 6, { unique = false } = {}) {
  const out = []
  for (const step of steps) {
    if (out.length > 0 && out[out.length - 1] === step) continue
    if (unique && out.includes(step)) continue
    if (out.length >= max) break
    out.push(step)
  }
  return out
}

export function outcomeOf(events) {
  let lastErrorAt = -1
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === 'tool/result' && events[i].data?.message?.isError) lastErrorAt = i
  }
  const recovered =
    lastErrorAt >= 0 &&
    events.slice(lastErrorAt + 1).some((e) => e.type === 'tool/result' && !e.data?.message?.isError)
  const lastError = lastErrorAt >= 0 ? clip(textOf(events[lastErrorAt].data.message.content), 120) : ''

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.type !== 'turn/end') continue
    const kind = ev.data?.reason?.kind
    if (kind === 'completed') {
      return lastErrorAt >= 0 && !recovered
        ? { status: 'partial', note: `工具失败未恢复：${lastError}` }
        : { status: 'success', note: '' }
    }
    if (kind === 'max-tokens') return { status: 'failure', note: '达到输出上限' }
    if (kind === 'error') {
      const msg = ev.data?.reason?.error?.message ?? '未知错误'
      return { status: 'failure', note: clip(msg, 120) }
    }
    if (kind === 'aborted') return { status: 'partial', note: '被中断' }
    return { status: 'partial', note: clip(kind ?? '未完成', 60) }
  }
  if (lastErrorAt >= 0) return { status: 'failure', note: lastError }
  return { status: 'success', note: '' }
}

/** Timestamped Markdown transcript of one turn. */
export function renderTranscript(events) {
  const lines = []
  for (const ev of events) {
    const at = fmtTime(ev.time)
    if (ev.type === 'user/message') {
      const text = textOf(ev.data?.content)
      if (text) lines.push(`## ${at} 用户\n${text}`)
    } else if (ev.type === 'assistant/message') {
      const text = textOf(ev.data?.message?.content)
      if (text) lines.push(`## ${at} 助手\n${text}`)
    } else if (ev.type === 'tool/call') {
      const args = clip(ev.data?.arguments ?? '', 200)
      lines.push(`## ${at} 工具 ${ev.data?.name ?? ''}\n> ${args}`)
    } else if (ev.type === 'tool/result') {
      const body = textOf(ev.data?.message?.content)
      const failed = ev.data?.message?.isError ? '（失败）' : ''
      if (body) {
        const head = body.slice(0, 400)
        const tail = body.length > 800 ? `\n…（省略 ${body.length - 800} 字符）\n${body.slice(-400)}` : ''
        const rest = body.length > 800 ? '' : body.slice(400)
        lines.push(`## ${at} 结果${failed}\n\`\`\`\n${head}${rest}${tail}\n\`\`\``)
      } else if (failed) {
        lines.push(`## ${at} 结果（失败）`)
      }
    }
  }
  return lines.join('\n\n')
}

/** Keep head 60% / tail 40% when the transcript exceeds the cap. */
export function capText(text, max) {
  if (!text || text.length <= max) return { text, truncated: false }
  const head = Math.floor(max * 0.6)
  const tail = max - head
  return {
    text: `${text.slice(0, head)}\n\n…（省略 ${text.length - max} 字符）…\n\n${text.slice(-tail)}`,
    truncated: true,
  }
}

function firstUserText(events) {
  for (const ev of events) {
    if (ev.type !== 'user/message') continue
    const text = textOf(ev.data?.content)
    if (text) return text
  }
  return ''
}

/** Rule-based summary for one turn. */
export function summarizeTurn(events) {
  const userText = firstUserText(events)
  const calls = events.filter((e) => e.type === 'tool/call')
  const flow = compactSteps(calls.map(toolStep))
  const outcome = outcomeOf(events)

  const fileCount = calls.filter((e) => FILE_TOOLS.has(e.data?.name)).length
  const shellCount = calls.filter((e) => SHELL_TOOLS.has(e.data?.name)).length
  const work = []
  if (shellCount) work.push(`运行 ${shellCount} 条命令`)
  if (fileCount) work.push(`修改 ${fileCount} 个文件`)
  const worked = work.length > 0 ? `（${work.join('，')}）` : ''

  const firstLine = clip(userText.split('\n').find((line) => line.trim()) ?? '', 40)
  const title = firstLine || (calls[0] ? `执行 ${calls[0].data?.name ?? '工具'}` : '未命名任务')
  const action = userText ? `${clip(userText, 100)}${worked}` : `执行 ${calls.length} 次工具调用${worked}`
  const flowText = flow.length > 0 ? `；流程：${flow.join(' → ')}` : ''
  const summary = clip(`${action}${flowText}；结果：${outcomeLabel(outcome)}`, 300)

  const tags = new Set()
  for (const call of calls) tags.add(call.data?.name ?? '')
  tags.delete('')

  return { title, action, flow, outcome: outcome.status, outcomeNote: outcome.note, summary, tags: [...tags].slice(0, 6) }
}

export function outcomeLabel(outcome) {
  if (outcome.status === 'success') return '成功'
  if (outcome.status === 'failure') return outcome.note ? `失败（${outcome.note}）` : '失败'
  return outcome.note ? `部分完成（${outcome.note}）` : '部分完成'
}

export function worstOutcome(values) {
  return values.reduce((worst, v) => (OUTCOME_RANK[v] > OUTCOME_RANK[worst] ? v : worst), 'success')
}

/** Merge several per-turn summaries into one episode summary. */
export function mergeEpisode(rows) {
  const first = rows[0]
  const flow = compactSteps(rows.flatMap((r) => r.flow ?? []), 8, { unique: true })
  const status = worstOutcome(rows.map((r) => r.outcome))
  const note = [...rows].reverse().find((r) => r.outcome === 'failure' && r.outcomeNote)?.outcomeNote ?? ''
  const action =
    rows.length === 1 ? first.action : `${first.action}（本段共 ${rows.length} 个回合；${rows[0].title} → ${rows[rows.length - 1].title}）`
  return {
    title: first.title,
    action: clip(action, 200),
    flow,
    outcome: status,
    outcomeNote: note,
    summary: clip(`${action}${flow.length ? `；流程：${flow.join(' → ')}` : ''}；结果：${outcomeLabel({ status, note })}`, 300),
  }
}