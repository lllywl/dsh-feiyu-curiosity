/**
 * 离线模拟：用一个假 ctx 跑 dsh-feiyu-curiosity 的 Host 半，
 * 验证「闪词 → 计分 → 落盘 → 路由快照」这条链路，不碰真实 Harness。
 *
 * 运行：node test/curiosity-sim.mjs [临时目录]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const target = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'curiosity-sim-'))
process.env.DSH_HOME = target

const mod = await import('../index.js')

const handlers = {}
const listeners = {}
let sectionText = ''
let toolDef

const stub = {
  tool: undefined,
  interval: undefined,
}

function fakeCtx() {
  return {
    get: (name) => {
      if (name === 'logger') return { info: () => {}, warn: () => {} }
      return undefined
    },
    effect: (fn) => {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    on: (name, fn) => {
      ;(listeners[name] ||= []).push(fn)
      return () => {
        const list = listeners[name] || []
        const index = list.indexOf(fn)
        if (index >= 0) list.splice(index, 1)
      }
    },
    systemPrompt: {
      section: (section) => {
        sectionText = typeof section.text === 'function' ? section.text : () => section.text
        return () => {
          sectionText = ''
        }
      },
    },
    webServer: {
      register: (route) => {
        handlers[route.path] = route.handler
        return () => {
          delete handlers[route.path]
        }
      },
    },
    tools: {
      register: (definition) => {
        toolDef = definition
        return () => {
          toolDef = undefined
        }
      },
    },
  }
}

mod.apply(fakeCtx(), {})

function emit(name, ...args) {
  for (const fn of listeners[name] || []) fn(...args)
}

function makeSession(id, origin) {
  return { id, header: { id, origin } }
}

const root = makeSession('root-session', undefined)
const child = makeSession('child-session', 'subagent')

let clock = Date.now()

function turn(session, turnNo, tokens, stepMs) {
  clock += 10
  emit('session/event', session, { type: 'turn/start', seq: 1, time: clock, data: { turn: turnNo } })
  clock += stepMs
  emit('session/event', session, {
    type: 'assistant/message',
    seq: 2,
    time: clock,
    data: { turn: turnNo, step: 0, message: {}, usage: { inputTokens: tokens - 200, outputTokens: 200, totalTokens: tokens } },
  })
  const flash = sectionText({ scope: { id: session.id } })
  clock += 5
  emit('session/event', session, { type: 'turn/end', seq: 3, time: clock, data: { turn: turnNo, reason: { kind: 'completed' } } })
  return flash
}

const flashes = []
for (let i = 1; i <= 6; i += 1) flashes.push(turn(root, i, 12000 + i * 1000, 2500))
// 子代理回合必须被排除
turn(child, 1, 99999, 1000)

const fail = []
const flashLines = flashes.filter(Boolean)
if (flashLines.length !== 6) fail.push(`每回合都该闪词，实际 ${flashLines.length}/6`)
if (!flashLines.every((line) => line.includes('【余光'))) fail.push('闪词行文本不符合预期')
if (flashLines[0] === flashLines[1]) fail.push('连续两回合闪了同一组词，降权没生效')

// 工具：dwell 记一笔
const dwell1 = await toolDef.execute({ action: 'dwell', word: flashLines[0].replace(/^【余光·本轮登场】(.*?)。.*$/s, '$1').split('、')[0], thought: '雨落在铁皮上会放大成一片噪声' }, { agent: root })
if (!dwell1 || !dwell1.ok) fail.push('curiosity dwell 失败：' + JSON.stringify(dwell1))
const peek = await toolDef.execute({ action: 'peek' }, { agent: root })
if (!peek || typeof peek.text !== 'string' || !peek.text.includes('热度榜')) fail.push('curiosity peek 输出异常')

// 路由：GET /state
function callGet(routePath) {
  return new Promise((resolve, reject) => {
    const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:65066' }, url: routePath }
    let status = 0
    let body = ''
    const res = {
      writeHead: (code) => {
        status = code
      },
      end: (payload) => {
        body = payload
        try {
          resolve({ status, json: JSON.parse(payload) })
        } catch (error) {
          reject(error)
        }
      },
    }
    handlers[routePath](req, res).catch(reject)
  })
}

const state1 = await callGet('/api/feiyu-curiosity/state')
if (state1.status !== 200) fail.push('GET /state 状态码 ' + state1.status)
const snap = state1.json
if (snap.totals.turns !== 6) fail.push(`回合数应为 6，实际 ${snap.totals.turns}`)
if (!snap.words.length) fail.push('词表为空')
if (snap.totals.tokens <= 0) fail.push('token 合计没有增长')
if (snap.totals.ms <= 0) fail.push('时长合计没有增长')
if (snap.words.length < 12) fail.push('种子词不足 12：' + snap.words.length)
// 上限是「每词每回合」：累计 ≤ cap×被闪次数 + 主动 dwell 的额外额度。
const overCap = snap.words.find((w) => w.tokens > 4000 * w.visits + 600 * (w.dwells + 1))
if (overCap) fail.push(`单词累计 token 超过上限：${overCap.word} ${overCap.tokens}/${overCap.visits}次`)
const overSingleRun = snap.words.find((w) => w.visits === 0 && w.tokens > 0)
if (overSingleRun) fail.push(`没被闪过的词却有分数：${overSingleRun.word}`)

// 状态落盘可重新加载
mod.apply(fakeCtx(), {})
const state2 = await callGet('/api/feiyu-curiosity/state')
if (state2.json.totals.turns !== 6) fail.push('重载后回合数丢失：' + state2.json.totals.turns)
if (state2.json.words.length !== snap.words.length) fail.push('重载后词数不一致')

// 加词路由
const addOk = await new Promise((resolve) => {
  const payload = JSON.stringify({ word: '萤火虫', theme: '自然' })
  const req = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:65066', 'content-type': 'application/json' },
    url: '/api/feiyu-curiosity/add',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(payload, 'utf8')
    },
  }
  const res = { writeHead: () => {}, end: (body) => resolve(JSON.parse(body)) }
  handlers['/api/feiyu-curiosity/add'](req, res)
})
if (!addOk.ok) fail.push('加词失败：' + JSON.stringify(addOk))

const state3 = await callGet('/api/feiyu-curiosity/state')
if (!state3.json.words.some((w) => w.word === '萤火虫')) fail.push('加的词没进账本')

// 非 loopback 必须被拒
const denied = await new Promise((resolve) => {
  const req = { method: 'GET', socket: { remoteAddress: '192.168.1.20' }, headers: { host: '127.0.0.1:65066' }, url: '/api/feiyu-curiosity/state' }
  const res = { writeHead: () => {}, end: (body) => resolve(JSON.parse(body)) }
  handlers['/api/feiyu-curiosity/state'](req, res)
})
if (denied.ok !== false) fail.push('非本机请求没有被拒绝')

const onDisk = JSON.parse(fs.readFileSync(path.join(target, 'curiosity', 'state.json'), 'utf8'))
if (onDisk.version !== 1) fail.push('state 版本号异常')

console.log('DSH_HOME =', target)
console.log('回合:', snap.totals.turns, '词数:', snap.totals.words, 'token:', snap.totals.tokens, '时长ms:', snap.totals.ms)
console.log('最近闪词示例:', flashLines[0])
console.log('热度前三:', snap.words.slice(0, 3).map((w) => `${w.word}(${w.tokens}t/${w.visits}次)`).join('  '))
console.log('dwell:', dwell1.text)
console.log('peek 前两行:', peek.text.split('\n').slice(0, 2).join(' | '))
console.log('磁盘 state 大小:', fs.statSync(path.join(target, 'curiosity', 'state.json')).size, 'bytes')

if (fail.length) {
  console.error('\nFAIL:')
  for (const line of fail) console.error(' - ' + line)
  process.exit(1)
}
console.log('\nOK: 闪词 / 计分 / 落盘 / 工具 / 路由 全部通过')
