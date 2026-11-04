# DeepSeek-Harness-Memory-Plugin
It work, isn't it?

## I'll not provide support for the program, not i don't want, just it written by AI. I believe you could make it better than me.

It's a program written by AI. All thing I do just tell it what i need, read what it did( It tell me. ). I never read the code, the truth about what it did. If you want to change or use it, just fork it. This is the end version of the project, without support.

#How to install
You just need to find a place to place it, then open the deepseek-harness-desktop to find the install button, don't need to follow install step tell below. You can also find the way in any other place to install it.

You can also see the following content in dsh-memory/OPERATIONS.md

# dsh-memory 操作手册

> 版本：1.0.0 · 当前状态：**已安装于 `desktop` profile**（entry `include:dsh-memory`；代码位于 `C:\Users\13456\Documents\deepseek-harness-plugins\dsh-memory`）
> 数据目录：`C:\Users\13456\.dsh\engram\` · 数据库：`engram.db`（SQLite，WAL）
> 依赖：无（只用 Node 内置 `node:sqlite` / `node:fs`），不联网，无删除接口。

---

## 1. 操作清单

模型可见的工具共 4 个，全部注册在 Host 全局层：

| 工具 | 作用 | 写库 | 会触发 α 淘汰 | 幂等 |
|---|---|---|---|---|
| `memory_save` | 记录刚完成的任务（成功或失败） | ✅ 写 1 条 `episodes` | ✅ 走写入门 | 否（每调用一次一条） |
| `memory_recall` | 检索记忆，**先返回摘要**（episodes），不够再补 memories | ✅ 只更新 `hits`/`last_hit_at` | ❌ | — |
| `memory_open` | 按 id 取回原文 | ✅ 只更新 `hits` | ❌ | — |
| `memory_stats` | 只读查看容量、计数器、淘汰状态 | ❌ | ❌ | — |

除此之外还有**自动写入**（不需要模型调用）：

| 触发 | 写入 |
|---|---|
| 每个回合结束（`turn/end`） | 1 条 `memories`（原文 + 规则摘要） |
| 空闲满 `gapMinutes`（默认 60 分钟） | 1 条 `episodes`（覆盖本段未总结的 memories） |
| 上下文占用 ≥ `pressureRatio`（默认 80%） | 同上，`trigger=context_pressure` |
| 回合以 `max-tokens` 结束 | 同上，`trigger=max_tokens` |
| 会话销毁（`session/disposed`） | 同上，`trigger=session_end` |

**没有删除/修改接口**：工具面没有 `memory_delete` / `memory_update` / `memory_clear`。

> α 淘汰（写入门）只处理 `evictGraceDays`（默认 7 天）**之外**的条目：保护期内的 episode/memory 既不回收原文，也不删行。候选排序 `hits ASC, at ASC, id ASC`。详见 §4/§5/§7。

---

## 2. 操作详解

### 2.1 `memory_save`

**用途**：把一个已完成的任务记进记忆库。成功、失败都要调用，一个任务一条。

**参数**

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | string | ✅ | 一句话说清「做了什么」，含关键对象/文件/命令。会变成召回卡片的第一句 |
| `outcome` | `success` \| `failure` \| `partial` | ✅ | 结果 |
| `title` | string | | 标题（≤60 字）；缺省取 `action` 前 40 字 |
| `steps` | string[] | | 操作流程，按发生顺序，每步 ≤60 字；没有操作就不传 |
| `note` | string | | 结果补充：失败原因、遗留问题、下一步 |
| `tags` | string[] | | 标签，如工具名/子系统名 |
| `detail` | string | | 需要原样保留的长内容（关键报错、命令输出、决策理由）；不传则用本回合对话原文 |

**返回**

| 字段 | 说明 |
|---|---|
| `ok` | 恒为 `true`；失败会抛错而不是返回 false |
| `skipped` | 子代理且 `includeSubagents=false` 时为 `true`，本次不写库 |
| `reason` | `skipped=true` 时为 `subagent` |
| `episodeId` | 新建的「总结触发」行 id（`ep_` 前缀）；`skipped=true` 时为 `null` |
| `memoryIds` | 本次**同时关联**的已落盘记忆 id 列表。本回合自己的记忆要等回合结束才写入，所以通常是 `[]` |
| `store.entries` / `store.bytes` / `store.capacity` | 当前条目数 / 占用字节 / 容量 L |

**行为**

1. 把本会话中尚未被任何 episode 覆盖的 `memories` 归拢为本段的「范围」；
2. **先**把这些原文按时间戳追加进 `journal/YYYY-MM-DD.md`；
3. 写 1 条 `episodes`（`trigger='explicit_save'`），并建立 `episode_memory` 关联；
4. 若传了 `detail`，它会追加到**本回合**那条 memory 的原文末尾（标记「补充说明（memory_save）」）；
5. 本回合结束时，那条 memory 会自动关联到本回合内创建的所有 episode；
6. 子代理且 `includeSubagents=false` 时直接返回 `{ok:true, skipped:true, reason:"subagent"}`，不执行 1–5。

**真实调用（本次会话）**

```jsonc
// 请求
{"action":"实现并安装 dsh-memory 本地记忆库插件（SQLite 单文件 + 摘要/原文两级 + 向量检索 + α 淘汰）",
 "title":"实现 dsh-memory 插件",
 "steps":["阅读 engram 源码与 DSH 服务契约","实测 Host 运行时 node:sqlite 与 FTS5","编写 12 个模块与 38 条单元测试","跑通 node --test 全绿","安装插件并解决 @deepseek-ai 包解析失败","重新激活并验证四个工具可用"],
 "outcome":"success",
 "note":"工具已注册，数据目录 C:\\Users\\13456\\.dsh\\engram，容量 1 GiB",
 "tags":["dsh-plugin","sqlite","memory"]}

// 返回
{"ok":true,"episodeId":"ep_0mw1trqg1dce3989a9c","memoryIds":[],
 "store":{"entries":1,"bytes":1075,"capacity":1073741824}}
```

---

### 2.2 `memory_recall`

**用途**：找记忆。**先搜「总结触发」条目（episodes），再用「原文+摘要」条目（memories）补足**；只回摘要，要原文再用 `memory_open`。

**参数**

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | ✅ | 自然语言或关键词 |
| `limit` | integer | | 返回条数 1–20，默认 5 |
| `project` | string | | 项目名；缺省取当前工作目录的目录名 |
| `since` | string | | 只看该时间之后（ISO 8601 或 epoch 毫秒） |
| `until` | string | | 只看该时间之前 |
| `scope` | `project` \| `all` | | 默认 `project`（本项目 + 全局），`all` 搜全部 |

**返回**

| 字段 | 说明 |
|---|---|
| `items[]` | 卡片数组，episodes 在前、memories 在后 |
| `items[].id` | `ep_…` 或 `mem_…`，可直接喂给 `memory_open` |
| `items[].source` | `episode` / `memory` |
| `items[].time` | 结束时间（epoch ms） |
| `items[].title` / `action` / `flow[]` / `outcome` | 摘要四要素 |
| `items[].project` | 项目名，全局记忆为 `null` |
| `items[].hits` | 该条在**本进程激活时**的累计召回/打开次数；之后的自增只落库、不回写卡片（见 §7） |
| `items[].memoryIds` | 仅 `source=memory` 时出现 |
| `total` | 本次返回的卡片数（被 `limit` 截断后） |
| `hint` | 提示语：无结果 / 被 token 预算截断 / 可继续 open |

**行为**

- 打分 = `RRF(BM25, 余弦)` × 时间衰减；词法走 JS 侧 BM25（含中文二元组），向量是 384 维本地哈希向量（int8）。
- 在 `limit` 名额内先填 episodes；被已返回 episode 覆盖的 memories 不重复出现。
- 单次总预算 `recallTokenBudget`（默认 5200 token），超出截断并在 `hint` 说明。
- 返回的每条都会 `hits += 1`（落盘，上限 2147483647）；卡片里的 `hits` 取自内存索引的**激活时快照**，不随后续召回更新（淘汰排序读库里的真实计数，所以排序不受影响）。

**真实调用**

```jsonc
// 请求
{"query":"本地记忆库插件 SQLite","limit":5}

// 返回
{"items":[{"id":"ep_0mw1trqg1dce3989a9c","source":"episode","time":1793779113877,
  "title":"实现 dsh-memory 插件",
  "action":"实现并安装 dsh-memory 本地记忆库插件（SQLite 单文件 + 摘要/原文两级 + 向量检索 + α 淘汰）",
  "flow":["阅读 engram 源码与 DSH 服务契约","实测 Host 运行时 node:sqlite 与 FTS5","编写 12 个模块与 38 条单元测试","跑通 node --test 全绿","安装插件并解决 @deepseek-ai 包解析失败","重新激活并验证四个工具可用"],
  "outcome":"success","project":"deepseek-harness","hits":1}],
 "total":1,"hint":"摘要不足时用 memory_open 取原文。"}
```

> 参数校验失败时不会返回这个结构，而是工具错误，例如首次调试时的：
> `Error: tool "memory_recall" returned invalid output: value is not lossless JSON`
> （原因是卡片里混进了 `undefined`，已修复。）

---

### 2.3 `memory_open`

**用途**：按 id 取原文。传 episode id 会自动展开成它覆盖的所有 memory。

**参数**

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ids` | string[] | ✅ | `memory_recall` 返回的 id；`ep_` 会展开 |
| `maxChars` | integer | | 每条上限，默认 8000，超出截断并标注 |

**返回**

| 字段 | 说明 |
|---|---|
| `items[].id` | memory id |
| `items[].title` / `time` / `summary` | 摘要信息 |
| `items[].body` | 带时间戳的原文（每段 `## YYYY-MM-DD HH:mm:ss 用户/助手/工具`） |
| `items[].truncated` | 是否被 `maxChars` 截断 |
| `items[].detailState` | `full` / `trimmed`（原文已被空间策略回收）/ `never` |
| `missing[]` | 查不到的 id |

**行为**：返回的 memory 会 `hits += 1`；`detailState='trimmed'` 时只有摘要、没有原文，属正常淘汰结果。

**真实调用**

```jsonc
// 请求
{"ids":["ep_0mw1trqg1dce3989a9c","mem_not_exist"]}

// 返回（该 episode 当时还没关联到记忆；不存在的 id 进 missing）
{"items":[],"missing":["mem_not_exist"]}
```

---

### 2.4 `memory_stats`

**用途**：只读查看容量与淘汰状态，排查用。

**参数**：无（`{}`）。

**返回**

| 字段 | 说明 |
|---|---|
| `entries` / `episodes` / `memories` | 总条目数及分表条目数 |
| `bytes` / `capacity` | 已用字节 / 配置的 L |
| `capacityAtRecompute` | 缓存 α 时使用的 L；与 `capacity` 不一致说明 α 还没按新 L 重算 |
| `recallTokenBudget` / `journalMaxBytes` / `gapMinutes` / `embedDims` | 本代进程实际生效的配置 |
| `alpha` | **缓存的** α（`g_avg / L`），只在重算时刻或 L 变更时变化 |
| `gAvg` | 缓存的平均新增字节数 |
| `callsSinceAvg` | 距下次重算还差多少（已累计的调用数） |
| `nextRecomputeIn` | = `max(0, max(1, ceil(entries/2)) - callsSinceAvg)` |
| `nextEvictCount` | 本次写入计划处理的条数 = `floor(alpha × entries)` |
| `evictGraceDays` | 当前生效的淘汰保护期（天） |
| `evictableEntries` | 可进入淘汰队列的条目数（`at <= now - evictGraceDays`） |
| `protectedEntries` | 保护期内的条目数 = `entries - evictableEntries` |
| `nextEvictCandidates` | 本次真正可能处理的条数 = `min(nextEvictCount, evictableEntries)` |
| `recentEvictions[]` | 本次插件激活内最近 5 次淘汰审计（`n` 条、处理了谁） |
| `dbPath` | 数据库绝对路径 |

**真实调用（三个时间点）**

```jsonc
// ① 插件刚装好、还没写任何东西
{"entries":0,"episodes":0,"memories":0,"bytes":0,"capacity":1073741824,
 "capacityAtRecompute":null,"recallTokenBudget":5200,"journalMaxBytes":1048576,
 "alpha":0,"gAvg":0,"callsSinceAvg":0,"nextRecomputeIn":1,"nextEvictCount":0,
 "recentEvictions":[],"dbPath":"C:\\Users\\13456\\.dsh\\engram\\engram.db"}

// ② 首次 memory_save 之后（g_avg = 第一条大小，α 同时写入）
{"entries":1,"episodes":1,"memories":0,"bytes":1075,"capacity":1073741824,
 "capacityAtRecompute":1073741824,
 "alpha":0.0000010011717677116394,"gAvg":1075,"callsSinceAvg":0,
 "nextRecomputeIn":1,"nextEvictCount":0 /* … */}

// ③ 第二次 memory_save 之后（α 没变，说明未到重算门槛）
{"entries":2,"episodes":2,"memories":0,"bytes":2215,"capacity":1073741824,
 "capacityAtRecompute":1073741824,
 "alpha":0.0000010011717677116394,"gAvg":1075,"callsSinceAvg":1,
 "nextRecomputeIn":0,"nextEvictCount":0,
 "recentEvictions":[{"ts":1793779273373,"alpha":0.0000010011717677116394,"gAvg":1075,"n":0,"deleted":[],"entries":1}]}
```

> 以上是加入保护期之前的实测样本；当前返回还会带 `evictGraceDays / evictableEntries / protectedEntries / nextEvictCandidates`，`recentEvictions` 的每条也多了 `cutoff / eligible / planned`。字段随版本增加，以实际返回为准。

---

## 3. 插件是怎么安装的

### 3.1 包的结构

实际安装目录（本机）：`C:\Users\13456\Documents\deepseek-harness-plugins\dsh-memory`；
profile 的 `node_modules\@local\dsh-memory` 是指向它的 junction。
`C:\Users\13456\Desktop\deepseek-harness\dsh-memory` 是审查副本，改它不会影响运行中的插件。

```
<实际安装目录>\
  package.json          name=@local/dsh-memory, type=module, dsh.bundle.patch
  cordis.patch.yml      - insert: [{ id: dsh-memory, name: '@local/dsh-memory' }]
  index.js              apply(ctx, config)
  src/*.js              12 个模块
  locale/{en,zh}.json   Plugin Manager 里显示的名称与描述
  icon.svg              图标
  test/*.test.mjs       9 个测试文件、71 条用例
```

`package.json` 关键字段：

```json
{
  "name": "@local/dsh-memory",
  "type": "module",
  "main": "index.js",
  "exports": { ".": "./index.js", "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

### 3.2 第一次安装（失败）

```
plugin_manager { action: "install_bundle", target: "C:\\Users\\13456\\Desktop\\deepseek-harness\\dsh-memory" }
```

返回：

```jsonc
{"stage":"enable","target":"@local/dsh-memory","enabled":true,"changed":true,
 "application":"failed",
 "packageResult":{"exitCode":0,"output":"+ @local/dsh-memory 1.0.0 <- ..\\..\\..\\Desktop\\deepseek-harness\\dsh-memory\n…"},
 "bundle":"@local/dsh-memory","version":"1.0.0",
 "error":{"code":"operation-error",
   "diagnostic":"dsh: warning: 1 entry did not activate\ndsh-memory (@local/dsh-memory): failed to import: Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-tools' imported from C:\\Users\\13456\\Desktop\\deepseek-harness\\dsh-memory\\index.js"}}
```

原因：插件 `import` 了 `@deepseek-ai/dsh-tools`（`defineTool`）和 `@deepseek-ai/schemastery`，而 workspace bundle 的解析路径里没有这两个包。
修复：改成**零 harness 依赖**——用 `ctx.tools.register({...})` 注册纯对象定义（`parameters` 直接写 JSON Schema），配置默认值改在 `src/config.js` 里处理，不再导出 `Config` schema。

### 3.3 重新激活

同一路径再 `install_bundle` 会返回 `already-installed`，因此用行级别开关重新加载：

```jsonc
// 1) 先找到 entry id
plugin_manager { action: "list_plugins", offset: 190, limit: 10 }
→ {"entryId":"include:dsh-memory","moduleName":"@local/dsh-memory","enabled":true,"fiberPhase":null,"patchId":"dsh-memory"}

// 2) 关
plugin_manager { action: "set_plugin", target: "include:dsh-memory", enabled: false }
→ {"stage":"enable","target":"include:dsh-memory","enabled":false,"changed":true,"application":"applied","warnings":[]}

// 3) 开（此时 apply() 执行成功）
plugin_manager { action: "set_plugin", target: "include:dsh-memory", enabled: true }
→ {"stage":"enable","target":"include:dsh-memory","enabled":true,"changed":true,"application":"applied","warnings":[]}
```

激活成功的旁证：进程里出现了 `C:\Users\13456\.dsh\engram\engram.db`（含 `-wal`/`-shm`）、`journal/`、`log/`。

### 3.4 后续升级 / 卸载

- **改代码后**：改 junction 目标目录（本机 `C:\Users\13456\Documents\deepseek-harness-plugins\dsh-memory`），再 `set_plugin false` → `set_plugin true`；不要改 Desktop 审查副本，也不要重复 `install_bundle`。
- **重装**：`remove_bundle { target: "@local/dsh-memory" }` → 再 `install_bundle { target: <绝对路径> }`。
- **配置来源**：
  1. `src/config.js` 的 `DEFAULTS` 是唯一默认值来源；
  2. 插件 `cordis.patch.yml` 的 insert 行不写 `config`；
  3. 本机需要覆盖时，在 `C:\Users\13456\.dsh\profiles\desktop\cordis.patch.yml` 增加 `dsh-memory` 行，`config` 是整体替换、不深合并，必须重述全部要保留的键。
- **改配置后**：重启 Harness，或 `set_plugin false → true`；再用 `memory_stats` 确认 `capacity`、`recallTokenBudget`、`journalMaxBytes` 等字段。
- **卸载**：`remove_bundle`；数据目录不会自动删除，需要手工删 `~/.dsh/engram`。

---

## 4. 数据与文件

```
C:\Users\13456\.dsh\engram\
  engram.db           344 KB   全部结构化数据（episodes / memories / episode_memory / meta）
  journal\2026-11-04.md 171 KB 总结前导出的带时间戳原文（人类可读）
  log\maintenance.jsonl 3.4 KB 每次 α 淘汰的审计
  log\plugin.log       3.7 KB 每次激活的配置与 resume 诊断
```

> 以上为 2026-11-04 20:49 的实测快照；运行期间还会出现 `engram.db-wal` / `engram.db-shm`。

### 三张业务表 + 一张计数器表

| 表 | 一行代表 | 关键字段 |
|---|---|---|
| `episodes` | 一次「总结触发」 | `trigger`、`action/flow/outcome`、`memory_count`、`hits`、`bytes` |
| `memories` | **一段原文 + 它的摘要** | `session_id`+`turn`（唯一）、`summary`、`content`、`content_state`、`content_bytes`、`hits` |
| `episode_memory` | 多对多关联 | `episode_id`、`memory_id` |
| `meta` | 全局计数 | `g_avg`、`alpha`、`capacity_bytes`、`calls_since_avg`、`bytes_added_since_avg`、`embed_dims` |

### 完整 DDL（`sqlite_master` 实测）

```sql
PRAGMA user_version = 1;      -- 迁移版本
PRAGMA journal_mode = wal;    -- WAL，读写不互斥
PRAGMA foreign_keys = 1;      -- 级联删除生效

CREATE TABLE episodes (
  id            TEXT PRIMARY KEY,          -- ep_<base36(ms)><hex>
  created_at    INTEGER NOT NULL,          -- 总结发生时刻 ms
  trigger       TEXT NOT NULL CHECK (trigger IN
                  ('idle_1h','context_pressure','max_tokens','session_end','explicit_save')),
  trigger_note  TEXT,                      -- "空闲 60 分钟" 等人类可读说明
  session_id    TEXT,
  project       TEXT,                      -- 工作目录名，召回时用于过滤
  cwd           TEXT,
  ts_start      INTEGER NOT NULL,          -- 覆盖的对话起点
  ts_end        INTEGER NOT NULL,
  title         TEXT NOT NULL,
  action        TEXT NOT NULL,             -- 「做了什么」
  flow          TEXT,                      -- JSON string[]，操作流程
  outcome       TEXT NOT NULL CHECK (outcome IN ('success','failure','partial')),
  outcome_note  TEXT,
  tags          TEXT,                      -- JSON string[]
  memory_count  INTEGER NOT NULL DEFAULT 0,-- 关联的 memories 条数（冗余缓存）
  hits          INTEGER NOT NULL DEFAULT 0,-- 被召回的次数；淘汰第一排序键
  last_hit_at   INTEGER,
  bytes         INTEGER NOT NULL,          -- 本行占用
  vec           BLOB,                      -- int8[384]，本地哈希向量
  vec_scale     REAL
);

CREATE TABLE memories (
  id            TEXT PRIMARY KEY,          -- mem_<base36(ms)><hex>
  session_id    TEXT NOT NULL,
  turn          INTEGER,                   -- 模型回合号
  project       TEXT,
  cwd           TEXT,
  ts_start      INTEGER NOT NULL,
  ts_end        INTEGER NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL,             -- 一段摘要（含"做了什么/流程/结果"）
  flow          TEXT,                      -- JSON string[]
  outcome       TEXT NOT NULL CHECK (outcome IN ('success','failure','partial')),
  outcome_note  TEXT,
  tags          TEXT,
  content       TEXT,                      -- 带时间戳原文；NULL = 已被回收
  content_state TEXT NOT NULL DEFAULT 'full' CHECK (content_state IN ('full','trimmed','never')),
  trimmed_at    INTEGER,
  hits          INTEGER NOT NULL DEFAULT 0,
  last_hit_at   INTEGER,
  bytes         INTEGER NOT NULL,          -- 摘要+向量部分
  content_bytes INTEGER NOT NULL DEFAULT 0,-- 原文部分（单独计费，回收时归零）
  vec           BLOB,
  vec_scale     REAL
);

CREATE TABLE episode_memory (
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  linked_at  INTEGER NOT NULL,
  PRIMARY KEY (episode_id, memory_id)
);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
```

索引（8 个）：

```sql
CREATE UNIQUE INDEX idx_mem_turn    ON memories(session_id, turn) WHERE turn IS NOT NULL;  -- 回写去重
CREATE INDEX idx_mem_hits    ON memories(hits, ts_end);        -- 淘汰排序
CREATE INDEX idx_mem_project ON memories(project, ts_end DESC);-- 按项目召回
CREATE INDEX idx_mem_time    ON memories(ts_end DESC);
CREATE INDEX idx_ep_hits     ON episodes(hits, created_at);    -- 淘汰排序
CREATE INDEX idx_ep_created  ON episodes(created_at DESC);
CREATE INDEX idx_ep_project  ON episodes(project, created_at DESC);
CREATE INDEX idx_em_memory   ON episode_memory(memory_id);     -- 反查引用数（级联判定）
```

**设计要点**

- `memories.bytes` 与 `content_bytes` 分开：回收原文只清 `content` 并把 `content_bytes=0`，摘要和向量不动，所以"详细记忆被删、摘要还在"是一次 UPDATE 而不是删行。
- `content_state` 三态：`full`（有原文）/ `trimmed`（已回收）/ `never`（从未写入）。
- 淘汰排序为 `hits ASC, at ASC, id ASC`（`at`：episode 用 `created_at`，memory 用 `ts_end`）；两张表各建一个复合索引，删除时先查 `candidates()`（UNION ALL）再按类型执行。
- 淘汰只处理 `evictGraceDays`（默认 7 天）之外的条目：`at <= now - evictGraceDays × 86400000`。保护期内既不回收原文也不删行；`evictGraceDays=0` 恢复旧行为。`episode` 出保时它覆盖的 memory 必然也已出保（episode 由 memory 触发产生），所以级联回收不额外判断保护期。
- `episode_memory` 双侧 `ON DELETE CASCADE`；删 episode 时还需判断受影响的 memory 是否已无任何引用，归零才回收原文。
- `idx_mem_turn` 是部分唯一索引（`WHERE turn IS NOT NULL`），既保证一个回合只落一条，又允许 `turn` 为空的手工记录。

### 真实数据快照（2026-11-04 20:49）

```
entries = 36   episodes = 10   memories = 26
meta: g_avg = 6732.0625
      alpha = 0.000006269721779972315
      capacity_bytes = 1073741824
      embed_dims = 384
```

> 行、关联和 meta 会随使用持续变化；具体值以 `memory_stats` 和实时 SQL 查询为准。

---

## 5. 配置

配置分三层：

1. `src/config.js` 的 `DEFAULTS` 是**唯一默认值来源**；
2. 插件 `cordis.patch.yml` 的 insert 行不写 `config`；
3. 本机需要覆盖时，在 `C:\Users\13456\.dsh\profiles\desktop\cordis.patch.yml` 增加 `- id: dsh-memory` 行。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dataDir` | `~/.dsh/engram` | 数据目录 |
| `capacityBytes` | `1073741824` | **L**，1 GiB |
| `evictGraceDays` | `7` | 淘汰保护期（天）；`0` = 关闭保护（旧行为） |
| `gapMinutes` | `60` | 空闲多久总结 |
| `pressureRatio` | `0.8` | 上下文占用多少触发总结 |
| `embedDims` | `384` | 向量维度；变更后启动时自动全量重编码 |
| `recallLimit` | `5` | 默认返回条数 |
| `recallTokenBudget` | `5200` | 单次召回 token 预算 |
| `detailMaxChars` | `24000` | 单条原文上限 |
| `journalMaxBytes` | `1048576` | journal 轮转上限，1 MiB（不计入 L） |
| `includeSubagents` | `false` | 是否记录子代理会话；false 时自动采集与 `memory_save` 都跳过子代理 |
| `recencyBoost` | `0.15` | 时间衰减权重 |

profile 覆盖示例（`config` 整体替换、不深合并，必须重述全部要保留的键）：

```yaml
- id: dsh-memory
  config:
    capacityBytes: 1073741824
    evictGraceDays: 7
    gapMinutes: 60
    recallTokenBudget: 5200
    journalMaxBytes: 1048576
```

> `capacityBytes` 变化时，插件激活阶段会用缓存的 `g_avg` 立即重算 `alpha`，并写入 `meta.capacity_bytes`；`memory_stats.capacityAtRecompute` 可用于确认。
>
> 注：插件不再导出 `Config` schema，因此 Settings 页面不会渲染表单；配置由 patch 传入并在 `src/config.js` 做默认值与钳制。

---

## 6. 已验证的行为

| 行为 | 证据 |
|---|---|
| 首写规则 `g_avg = 第一条大小` | 首写后 `g_avg=1075`、`α=1075/1073741824`、`calls=0` |
| α 只在重算时更新 | 第二次写入后 `α` 数值**未变**，`callsSinceAvg=1` |
| L 变更时立即重算 α | 重载后 `memory_stats.capacity` 与 `capacityAtRecompute` 一致，`alpha = gAvg / capacity` |
| 条数向下取整 | 两次写入的审计 `n=0`；入口 `nextEvictCount=0` |
| 7 天保护期 | 候选只含 `at <= now - evictGraceDays×86400000` 的条目；保护期内的记忆既不回收原文也不删行；`evictGraceDays=0` 回到旧行为（单测覆盖） |
| 淘汰排序 | `hits ASC, at ASC, id ASC`：hits 少的先淘汰，同 hits 时更久远的先淘汰（单测覆盖） |
| 回合结束自动落 memories | 回合结束后出现 `turn=4` 的 memory（原文 17803 字节），并自动关联对应 episode |
| 会话闲置结段可跨重载 | 激活时 `reconcileIdle()` 用事件 `time` 重算空闲：已超时就补 `idle_1h`，未超时就按剩余时间重挂计时器；新事件到来时先补做空档结段（单测覆盖） |
| episodes.memory_count 随级联更新 | 淘汰删掉 memory 行后，`refreshMemoryCount()` 重算受影响的 episode（单测覆盖） |
| 模型会主动调用 `memory_save` | 产生了 `explicit_save` episode（标题「取 session.v4.txt 后半段…」） |
| journal 先于摘要 | `journal/2026-11-04.md` 中每个 episode 的内容都在其落库前写入 |
| episodes 优先召回 | `memory_recall` 先返回 `ep_…`，hits 自增 |
| 原文带时间戳 | memory 原文每段形如 `## 2026-11-04 15:58:13 用户/助手/工具` |
| 索引不缓存原文 | `Search.rebuild()` 使用 `indexMemories()` 投影，`memories` Map 中 `content` 为 `undefined` |
| 子代理不写库 | `includeSubagents=false` 时子代理 `memory_save` 返回 `ok:true, skipped:true`，不产生 episode |
| 写失败可补写 | `turn/end` 写入失败进入 `state.pending`，后续事件或 `dispose` 自动重试 |

---

## 7. 限制与排错

**已知限制**

- 只检索摘要字段，不做原文全文检索（FTS5 的 trigram 对 2 字中文失效，未接入）。
- 哈希向量无语义泛化力，陌义改写靠 BM25 兜底。
- 每条 `hits` 达到 2147483647 后不再增长（不回绕），此时它在淘汰序列里永远排最后。
- **保护期内可能超过 L**：全部条目都在 `evictGraceDays`（默认 7 天）内时 `planned=0`，本次不淘汰，库可暂时超过 `capacityBytes`；出保后按 `floor(α×N)` 逐次消化，不会一次性清空。把 `capacityBytes` 调得很小（如测试用的 1 MiB）时这个窗口会很明显，可把 `evictGraceDays` 设为 0 或调小。
- `embedDims` 变更后会在下次启动时全量重编码；1 GiB 库首次切换维度会延长激活时间，日志会打印 `reindexed N rows`。
- `memory_recall` 卡片里的 `hits` 是**插件激活时**的快照，不会随后续召回/打开增长；真实计数在库里的 `hits` 列（淘汰排序用它），`memory_stats` 不展示。`total` 是本次返回的卡片数。
- `recentEvictions` 只保留本次插件激活内的记录，重载后为空；历史审计仍在 `log/maintenance.jsonl`。
- **重载会切开当前回合**：插件不持久化"本回合未写完的缓冲"，重载后靠 `Capture.resume()` 从 `snapshotEvents()` 重放到最后一个 `turn/end`，并回填本回合已创建的 `explicit_save` episode。历史数据不受影响，但重载瞬间到 resume 之间若恰好有事件提交，那一小段可能缺失（正常情况下同步执行，不会发生）。
- **空闲计时器不持久化，但闲置时长可重算**：DSH 为每条事件记录了 `time`，激活时 `Capture.reconcileIdle()` 用会话事件里最后一条的时间重算空闲——已超过 `gapMinutes` 就立即补一条 `idle_1h`，否则按剩余时间重挂计时器；新事件到来时也会先校验一次空档（`checkIdleGap()`）。所以重启不会丢"该结的段"。
- **pending 队列只在内存**：写入失败时记忆会进入 `state.pending` 并在后续事件/关闭时重试；插件卸载时仍未写成的 pending 会丢失，日志会打印剩余数量。

**排错**

| 现象 | 原因 / 处理 |
|---|---|
| 工具不出现 | `plugin_manager list_plugins` 看 `include:dsh-memory` 的 `fiberPhase`；`null` 表示没激活，`set_plugin` 关开一次 |
| `ERR_MODULE_NOT_FOUND` | 插件又引入了 harness 包；回退到零依赖写法 |
| 召回为空 | 换关键词、放宽 `since/until`、或 `scope:"all"`；库为空时先 `memory_save` |
| 原文显示 `trimmed` | 空间策略已回收原文，摘要仍在 |
| 数字对不上 | 用 `memory_stats` 看 `capacity`/`capacityAtRecompute`/`alpha`/`g_avg`/`nextEvictCount`/`evictableEntries`/`protectedEntries`/`nextEvictCandidates`，对照 `log/maintenance.jsonl` 审计（每行含 `cutoff/eligible/planned`） |
| 最近写入的记忆没被淘汰 | 正常：`evictGraceDays`（默认 7 天）内的条目不进入候选；看 `memory_stats.evictableEntries` 是否为 0 |
| 改配置后行为没变 | 配置在激活时读取；`set_plugin false → true` 或重启，再用 `memory_stats` 核对配置字段 |
| 向量召回变差 | 检查 `memory_stats.embedDims` 与 `meta.embed_dims`；维度变更后启动日志应有 `reindexed N rows` |
