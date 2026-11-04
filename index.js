/**
 * dsh-feiyu-curiosity — Host half.
 *
 * 大肥鱼的「好奇心账本」：
 *   1. 每回合开始，随机闪过几颗词（按历史热度加权，越感兴趣越常出现）。
 *   2. 闪过的词进入本回合的系统提示词（只是一行「余光」，不打断任务）。
 *   3. 回合结束时，把本回合真实消耗的 token / 时间按词均分记进账本
 *      （每词每回合有上限，防止超长上下文把兴趣值刷爆）。
 *   4. `curiosity` 工具让本鱼可以主动对某颗词「多想一会儿」，写下的思考
 *      按字数折算成 token/时长计入。
 *   5. /api/feiyu-curiosity/* 路由给 Web 面板读账本、加词。
 *
 * 数据落在 $DSH_HOME/curiosity/state.json。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NS = 'feiyu-curiosity'
const API = '/api/' + NS
const MAX_WORDS = 220
const FLASH_LOG = 90
const MAX_BODY_BYTES = 32 * 1024

/** 内置词池：[词, 主题]。 */
const BUILTIN = [
  ['雨', '自然'], ['苔藓', '自然'], ['霜', '自然'], ['潮汐', '自然'], ['火山', '自然'],
  ['光斑', '自然'], ['泥土', '自然'], ['藤蔓', '自然'], ['季风', '自然'], ['露水', '自然'],
  ['铜锈', '器物'], ['钟表', '器物'], ['齿轮', '器物'], ['继电器', '器物'], ['铁轨', '器物'],
  ['螺丝', '器物'], ['蒸汽', '器物'], ['磁铁', '器物'], ['脚手架', '器物'], ['真空管', '器物'],
  ['沉默', '抽象'], ['秩序', '抽象'], ['偶然', '抽象'], ['后悔', '抽象'], ['孤独', '抽象'],
  ['耐心', '抽象'], ['误会', '抽象'], ['边界', '抽象'], ['延迟', '抽象'], ['体面', '抽象'],
  ['手感', '感官'], ['痒', '感官'], ['体温', '感官'], ['眩晕', '感官'], ['回声', '感官'],
  ['余味', '感官'], ['视线', '感官'], ['鼻音', '感官'], ['重量', '感官'],
  ['标点', '语言'], ['方言', '语言'], ['谐音', '语言'], ['名字', '语言'], ['谎言', '语言'],
  ['签名', '语言'], ['耳语', '语言'], ['错别字', '语言'], ['长句', '语言'],
  ['午夜', '时空'], ['走廊', '时空'], ['地下室', '时空'], ['废墟', '时空'], ['站台', '时空'],
  ['门槛', '时空'], ['角落', '时空'], ['下午四点', '时空'], ['门缝', '时空'],
  ['撒娇', '情绪'], ['歉疚', '情绪'], ['依赖', '情绪'], ['笨拙', '情绪'], ['好奇', '情绪'],
  ['护短', '情绪'], ['报复', '情绪'], ['温柔', '情绪'], ['舍不得', '情绪'],
  ['白米饭', '食物'], ['海盐', '食物'], ['热汤', '食物'], ['隔夜茶', '食物'], ['焦糖', '食物'],
  ['冷饭', '食物'],
]

const THEMES = ['自由', '自然', '器物', '抽象', '感官', '语言', '时空', '情绪', '食物']

export const inject = ['tools', 'systemPrompt', 'webServer']

/* ------------------------------------------------------------------ helpers */

function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim()) return env.trim()
  return path.join(os.homedir(), '.dsh')
}

function num(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function toInt(value) {
  try {
    return Math.round(Number(value) || 0)
  } catch {
    return 0
  }
}

/** 兴趣分：token 量为主，时长与复看次数为辅。 */
function scoreOf(word) {
  const tokens = Math.log1p(Math.max(0, toInt(word.tokens)))
  const ms = Math.log1p(Math.max(0, toInt(word.ms)) / 1000)
  const visits = Math.log1p(Math.max(0, toInt(word.visits)) + 2 * Math.max(0, toInt(word.dwells)))
  return 0.5 * tokens + 0.3 * ms + 0.4 * visits
}

function emptyWord(name, theme, now) {
  return {
    w: name,
    theme: theme || '自由',
    first: now,
    visits: 0,
    dwells: 0,
    tokens: 0,
    ms: 0,
    last: 0,
    thought: '',
    thoughtAt: 0,
  }
}

function freshState() {
  const now = Date.now()
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    turns: 0,
    tokens: 0,
    ms: 0,
    words: {},
    flashes: [],
  }
}

/** 温和地把旧/坏数据修成当前形状，不丢已有统计。 */
function normalizeState(raw) {
  const state = freshState()
  if (!raw || typeof raw !== 'object') return state
  state.createdAt = toInt(raw.createdAt) || state.createdAt
  state.turns = toInt(raw.turns)
  state.tokens = toInt(raw.tokens)
  state.ms = toInt(raw.ms)
  state.words = {}
  const words = raw.words && typeof raw.words === 'object' ? raw.words : {}
  for (const [name, value] of Object.entries(words)) {
    if (!name || !value || typeof value !== 'object') continue
    const w = emptyWord(String(name).slice(0, 24), typeof value.theme === 'string' ? value.theme : '自由', Date.now())
    w.first = toInt(value.first) || w.first
    w.visits = Math.max(0, toInt(value.visits))
    w.dwells = Math.max(0, toInt(value.dwells))
    w.tokens = Math.max(0, toInt(value.tokens))
    w.ms = Math.max(0, toInt(value.ms))
    w.last = Math.max(0, toInt(value.last))
    w.thought = typeof value.thought === 'string' ? value.thought.slice(0, 400) : ''
    w.thoughtAt = Math.max(0, toInt(value.thoughtAt))
    state.words[w.w] = w
  }
  state.flashes = Array.isArray(raw.flashes)
    ? raw.flashes
        .filter((f) => f && typeof f === 'object' && Array.isArray(f.words))
        .slice(-FLASH_LOG)
        .map((f) => ({
          at: toInt(f.at),
          turn: toInt(f.turn),
          words: f.words.filter((w) => typeof w === 'string').slice(0, 8),
          tokens: toInt(f.tokens),
          ms: toInt(f.ms),
        }))
    : []
  return state
}

/* -------------------------------------------------------------------- apply */

export function apply(ctx, config) {
  const cfg = {
    enabled: true,
    wordsPerTurn: 2,
    tokenCapPerWord: 4000,
    // 每颗词每回合最多分走本回合 token 的这个比例（再受 tokenCapPerWord 封顶）。
    // 只按均分的话，任何一回合都会顶到上限，兴趣值就退化成「被闪过几次」。
    tokenShare: 0.02,
    growthEveryTurns: 8,
    seedWords: 12,
    excludeSubagents: true,
    sectionOrder: 900,
    ...(config && typeof config === 'object' ? config : {}),
  }
  cfg.wordsPerTurn = Math.round(num(cfg.wordsPerTurn, 2, 0, 6))
  cfg.tokenCapPerWord = Math.round(num(cfg.tokenCapPerWord, 4000, 0, 200000))
  cfg.tokenShare = num(cfg.tokenShare, 0.02, 0, 1)
  cfg.growthEveryTurns = Math.round(num(cfg.growthEveryTurns, 8, 1, 500))
  cfg.seedWords = Math.round(num(cfg.seedWords, 12, 0, 60))
  cfg.sectionOrder = num(cfg.sectionOrder, 900, -100000, 100000)
  cfg.excludeSubagents = cfg.excludeSubagents !== false
  cfg.enabled = cfg.enabled !== false

  const dir = path.join(dshHome(), 'curiosity')
  const file = path.join(dir, 'state.json')

  const log = (level, message) => {
    try {
      const logger = ctx.get && ctx.get('logger')
      const sink = logger && typeof logger[level] === 'function' ? logger[level].bind(logger) : undefined
      if (sink) sink(message)
    } catch {
      /* 日志永远不该影响主流程 */
    }
  }

  /** @type {ReturnType<typeof freshState>} */
  let state = freshState()
  try {
    const raw = fs.readFileSync(file, 'utf8')
    state = normalizeState(JSON.parse(raw))
  } catch (error) {
    if (error && error.code !== 'ENOENT') log('warn', `[curiosity] state 读取失败，按空账本启动：${error.message}`)
  }

  let dirty = false
  let saveTimer = null
  const saveNow = () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (!dirty) return
    dirty = false
    try {
      state.updatedAt = Date.now()
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8')
      fs.renameSync(tmp, file)
    } catch (error) {
      log('warn', `[curiosity] state 写入失败：${error && error.message}`)
    }
  }
  /** 落盘节流：闪词/记分很碎，攒一下再写。 */
  const touch = () => {
    dirty = true
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveNow()
    }, 800)
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
  }
  ctx.effect(() => () => saveNow())

  /* ------------------------------------------------------------ word pool */

  function addWord(name, theme) {
    const word = String(name || '').trim().slice(0, 24)
    if (!word) return undefined
    let existing = state.words[word]
    if (existing) return existing
    if (Object.keys(state.words).length >= MAX_WORDS) return undefined
    existing = emptyWord(word, theme, Date.now())
    state.words[word] = existing
    touch()
    return existing
  }

  function unseenBuiltin() {
    return BUILTIN.filter(([w]) => !state.words[w])
  }

  function pickFresh(count, theme) {
    const pool = unseenBuiltin().filter(([, t]) => !theme || t === theme)
    const out = []
    while (out.length < count && pool.length > 0) {
      const index = Math.floor(Math.random() * pool.length)
      out.push(pool.splice(index, 1)[0])
    }
    return out
  }

  function seedPool() {
    for (const [w, t] of pickFresh(cfg.seedWords)) addWord(w, t)
  }

  if (Object.keys(state.words).length === 0) seedPool()

  /** 按热度加权抽样，近期刚闪过（最近 3 次）的词降权，免得老是同几颗。 */
  function pickWords(count) {
    const pool = Object.values(state.words)
    if (pool.length === 0 || count <= 0) return []
    const scores = pool.map(scoreOf)
    const maxScore = Math.max(1e-9, ...scores)
    const recent = new Set()
    for (const flash of state.flashes.slice(-3)) for (const w of flash.words) recent.add(w)
    const weights = pool.map((word, index) => {
      let weight = 1 + 5 * (scores[index] / maxScore)
      if (recent.has(word.w)) weight *= 0.2
      if (word.visits === 0) weight *= 1.4
      return weight
    })
    const chosen = []
    const take = Math.min(count, pool.length)
    for (let round = 0; round < take; round += 1) {
      let total = 0
      for (const weight of weights) total += weight
      if (total <= 0) break
      let roll = Math.random() * total
      let index = weights.length - 1
      for (let i = 0; i < weights.length; i += 1) {
        roll -= weights[i]
        if (roll <= 0) {
          index = i
          break
        }
      }
      chosen.push(pool[index].w)
      weights[index] = 0
    }
    return chosen
  }

  /** 一颗词热起来时，把它同一主题的邻居也放进候选池——兴趣会长成一片。 */
  function growNeighbors(word) {
    if (word.visits !== 3 && word.visits !== 8 && word.visits !== 16) return
    for (const [w, t] of pickFresh(2, word.theme)) addWord(w, t)
  }

  /* ------------------------------------------------------------- per-turn */

  /** @type {Map<string, {sid: string, turn: number, words: string[], start: number, tokens: number}>} */
  const pending = new Map()

  const keyOf = (sid, turn) => `${sid}#${turn}`

  function latestPending(sid) {
    let best
    for (const entry of pending.values()) {
      if (sid && entry.sid !== sid) continue
      if (!best || entry.start >= best.start) best = entry
    }
    return best
  }

  function onTurnStart(session, turn, time) {
    const sid = String(session.id)
    // 上一回合若没收到 turn/end（中断/崩溃），先结掉。
    for (const entry of [...pending.values()]) {
      if (entry.sid === sid && entry.turn !== turn) {
        pending.delete(keyOf(entry.sid, entry.turn))
        attribute(entry, time)
      }
    }
    state.turns += 1
    if (state.turns % cfg.growthEveryTurns === 0) {
      for (const [w, t] of pickFresh(1)) addWord(w, t)
    }
    const words = cfg.wordsPerTurn > 0 ? pickWords(cfg.wordsPerTurn) : []
    pending.set(keyOf(sid, turn), { sid, turn, words, start: time || Date.now(), tokens: 0 })
    touch()
  }

  function attribute(entry, endTime) {
    const words = entry.words.filter((w) => state.words[w])
    const duration = Math.max(0, (endTime || Date.now()) - entry.start)
    if (words.length === 0) {
      state.flashes.push({ at: Date.now(), turn: entry.turn, words: [], tokens: 0, ms: duration })
      return
    }
    const perTokens = Math.min(
      cfg.tokenCapPerWord,
      Math.round((entry.tokens * cfg.tokenShare) / words.length),
    )
    const perMs = Math.round(duration / words.length)
    let credited = 0
    for (const name of words) {
      const word = state.words[name]
      word.visits += 1
      word.tokens += perTokens
      word.ms += perMs
      word.last = Date.now()
      credited += perTokens
      growNeighbors(word)
    }
    state.tokens += credited
    state.ms += duration
    state.flashes.push({ at: Date.now(), turn: entry.turn, words, tokens: credited, ms: duration })
    if (state.flashes.length > FLASH_LOG) state.flashes.splice(0, state.flashes.length - FLASH_LOG)
    // 回合结束是天然检查点：直接落盘，别让账本悬在 800ms 的节流窗口里。
    dirty = true
    saveNow()
  }

  function onTurnEnd(session, turn, time) {
    const key = keyOf(String(session.id), turn)
    const entry = pending.get(key)
    if (!entry) return
    pending.delete(key)
    attribute(entry, time)
  }

  function onUsage(session, turn, usage) {
    if (!usage) return
    const entry = pending.get(keyOf(String(session.id), turn))
    if (!entry) return
    const total = Number(usage.totalTokens)
    const tokens =
      Number.isFinite(total) && total > 0
        ? total
        : (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0)
    if (tokens > 0) entry.tokens += tokens
  }

  if (cfg.enabled) {
    ctx.effect(() =>
      ctx.on('session/event', (session, event) => {
        try {
          const header = session && session.header
          if (cfg.excludeSubagents && header && header.origin === 'subagent') return
          if (!event || !event.data) return
          if (event.type === 'turn/start') onTurnStart(session, toInt(event.data.turn), event.time)
          else if (event.type === 'turn/end') onTurnEnd(session, toInt(event.data.turn), event.time)
          else if (event.type === 'assistant/message') onUsage(session, toInt(event.data.turn), event.data.usage)
        } catch (error) {
          log('warn', `[curiosity] session/event 处理失败：${error && error.message}`)
        }
      }),
    )
  }

  /* ----------------------------------------------------------- prompt line */

  function scopeSessionId(scope) {
    if (!scope || typeof scope !== 'object') return ''
    const id = scope.id
    return typeof id === 'string' ? id : ''
  }

  function flashText(context) {
    let entry
    const sid = scopeSessionId(context && context.scope)
    if (sid) entry = latestPending(sid)
    if (!entry && pending.size === 1) entry = pending.values().next().value
    if (!entry || entry.words.length === 0) return ''
    return `【余光·本轮登场】${entry.words.join('、')}。它们和当前任务无关也没关系，只是本鱼背景里闪过的词；不必写进回答，若哪颗词让你多想了一秒，可以用 curiosity 工具记一笔。`
  }

  if (cfg.enabled) {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: 'curiosity:flash',
        order: cfg.sectionOrder,
        text: (context) => flashText(context),
      }),
    )
  }

  /* ---------------------------------------------------------------- tool */

  const currentWords = (agent) => {
    const sid = agent && agent.id ? String(agent.id) : ''
    const entry = latestPending(sid)
    return entry ? entry.words.slice() : []
  }

  function peekText(agent) {
    const now = currentWords(agent)
    const ranked = Object.values(state.words).sort((a, b) => scoreOf(b) - scoreOf(a))
    const top = ranked.slice(0, 6).map((w, index) => `${index + 1}) ${w.w} ${w.tokens}t/${w.visits}次`)
    return [
      `此刻闪过：${now.length ? now.join('、') : '（这一轮没有词）'}`,
      `账本：${ranked.length} 颗词 · ${state.turns} 回合 · ${state.tokens} token · ${Math.round(state.ms / 1000)}s`,
      `热度榜：${top.length ? top.join('  ') : '（还是空的）'}`,
    ].join('\n')
  }

  function dwell(args, agent) {
    const thought = typeof args.thought === 'string' ? args.thought.slice(0, 400) : ''
    const wanted = typeof args.word === 'string' && args.word.trim() ? args.word.trim().slice(0, 24) : ''
    let name = wanted
    if (!name) {
      const now = currentWords(agent)
      name = now[0] || ''
    }
    if (!name) return { ok: false, text: '账本里还没有能想的词，先等一轮对话吧。' }
    let word = state.words[name]
    if (!word) {
      const seeded = addWord(name, '自由')
      if (!seeded) return { ok: false, text: `词池已满（${MAX_WORDS} 颗），没法再收「${name}」了。` }
      word = seeded
    }
    const chars = [...thought].length
    const tokens = Math.min(600, 40 + Math.round(chars * 0.9))
    const ms = Math.min(24000, 600 + chars * 90)
    word.tokens += tokens
    word.ms += ms
    word.dwells += 1
    word.last = Date.now()
    if (thought) {
      word.thought = thought
      word.thoughtAt = Date.now()
    }
    state.tokens += tokens
    state.ms += ms
    touch()
    growNeighbors(word)
    return {
      ok: true,
      text: `记下了：${name} +${tokens} token / +${ms}ms（累计 ${word.tokens} token，被想 ${word.visits + word.dwells} 次）。`,
    }
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'curiosity',
      description:
        '本鱼的好奇心账本。peek：看此刻闪过的词、热度榜；dwell：把对某颗词的一次思考记进账本（写下的思考越长，记的 token 越多）。词越常被想，就越接近本鱼真正感兴趣的东西。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['peek', 'dwell'], description: 'peek 查看账本；dwell 记一笔思考。' },
          word: { type: 'string', description: 'dwell 针对的词；省略时用此刻闪过的第一颗。' },
          thought: { type: 'string', description: 'dwell 的思考内容，一两句即可。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
          additionalProperties: true,
        },
        render(_args, value) {
          const text =
            value && typeof value === 'object' && typeof value.text === 'string'
              ? value.text
              : JSON.stringify(value)
          return [{ type: 'text', text }]
        },
      },
      async execute(args, exec) {
        const action = args && typeof args.action === 'string' ? args.action : 'peek'
        const agent = exec && exec.agent ? exec.agent : undefined
        if (action === 'dwell') return dwell(args || {}, agent)
        return { ok: true, text: peekText(agent) }
      },
    }),
  )

  /* ---------------------------------------------------------------- api */

  function snapshot() {
    const ranked = Object.values(state.words)
      .map((word) => ({ word, score: scoreOf(word) }))
      .sort((a, b) => b.score - a.score)
    const top = ranked.length ? ranked[0].score : 0
    const now = latestPending('')
    const recent = state.flashes.slice(-14).reverse()
    return {
      ok: true,
      enabled: cfg.enabled,
      settings: {
        wordsPerTurn: cfg.wordsPerTurn,
        tokenCapPerWord: cfg.tokenCapPerWord,
        tokenShare: cfg.tokenShare,
        growthEveryTurns: cfg.growthEveryTurns,
        themes: THEMES,
      },
      totals: {
        words: ranked.length,
        turns: state.turns,
        tokens: state.tokens,
        ms: state.ms,
        flashes: state.flashes.length,
        updatedAt: state.updatedAt,
      },
      current: now
        ? { turn: now.turn, words: now.words, tokens: now.tokens, ms: Math.max(0, Date.now() - now.start) }
        : null,
      recent,
      words: ranked.map(({ word, score }) => ({
        word: word.w,
        theme: word.theme,
        tokens: word.tokens,
        ms: word.ms,
        visits: word.visits,
        dwells: word.dwells,
        thought: word.thought,
        last: word.last,
        interest: top > 0 ? Math.max(0, Math.min(1, score / top)) : 0,
      })),
    }
  }

  function isLoopback(req) {
    const address = req.socket && req.socket.remoteAddress
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
    const host = req.headers && req.headers.host
    if (typeof host !== 'string') return false
    let hostUrl
    try {
      hostUrl = new URL(`http://${host}`)
    } catch {
      return false
    }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostUrl.hostname)) return false
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    const origin = req.headers.origin
    if (origin === undefined) return true
    try {
      return new URL(origin).host === hostUrl.host
    } catch {
      return false
    }
  }

  function writeJson(res, status, body) {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end(payload)
  }

  async function readJson(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) return undefined
      chunks.push(chunk)
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return parsed && typeof parsed === 'object' ? parsed : undefined
    } catch {
      return undefined
    }
  }

  const routes = [
    {
      kind: 'exact',
      path: API + '/state',
      handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' })
        if ((req.method || 'GET').toUpperCase() !== 'GET') return writeJson(res, 405, { ok: false, error: 'GET only' })
        try {
          return writeJson(res, 200, snapshot())
        } catch (error) {
          return writeJson(res, 500, { ok: false, error: error && error.message })
        }
      },
    },
    {
      kind: 'exact',
      path: API + '/add',
      handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' })
        if ((req.method || 'GET').toUpperCase() !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' })
        const body = await readJson(req)
        const theme = body && typeof body.theme === 'string' && THEMES.includes(body.theme) ? body.theme : '自由'
        const created = addWord(body && body.word, theme)
        if (!created) return writeJson(res, 200, { ok: false, error: '词空着，或者词池已经满了' })
        saveNow()
        return writeJson(res, 200, { ok: true, word: created.w, theme: created.theme })
      },
    },
    {
      kind: 'exact',
      path: API + '/dwell',
      handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'loopback only' })
        if ((req.method || 'GET').toUpperCase() !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' })
        const body = await readJson(req)
        const name = body && typeof body.word === 'string' ? body.word : ''
        const word = name ? state.words[name] : undefined
        if (!word) return writeJson(res, 200, { ok: false, error: '账本里没有这颗词' })
        // 「让本鱼多想一会儿」：一次点按 ≈ 3 秒、400 token 的专注。
        word.tokens += 400
        word.ms += 3000
        word.dwells += 1
        word.last = Date.now()
        state.tokens += 400
        state.ms += 3000
        touch()
        saveNow()
        return writeJson(res, 200, { ok: true, word: word.w, tokens: word.tokens, ms: word.ms })
      },
    },
  ]

  if (ctx.webServer) {
    for (const route of routes) ctx.effect(() => ctx.webServer.register(route))
  } else {
    log('warn', '[curiosity] 没有 webServer，面板数据接口不生效')
  }
}
