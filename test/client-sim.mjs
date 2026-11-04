/**
 * 离线模拟：在 Node 里假装一趟浏览器模块加载器（window.__ModuleLoader__ + 迷你 React），
 * 验证 Client 半的槽位注册与面板渲染，不碰真实 GUI。
 *
 * 运行：node test/client-sim.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(here, '../client.js')
const source = fs.readFileSync(CLIENT, 'utf8')

/* ------------------------------------------------------------- mini React */

const Fragment = Symbol('Fragment')

function createElement(type, props, ...children) {
  return { type, props: { ...(props || {}), children: flatten(children) } }
}
function flatten(list) {
  const out = []
  for (const item of list) {
    if (Array.isArray(item)) out.push(...flatten(item))
    else if (item === null || item === undefined || item === false || item === true) continue
    else out.push(item)
  }
  return out
}

let hooks = []
let hookIndex = 0
let dirty = false
let effectQueue = []

function useState(initial) {
  const index = hookIndex++
  const slot = hooks[index] || (hooks[index] = { value: typeof initial === 'function' ? initial() : initial })
  const set = (next) => {
    const value = typeof next === 'function' ? next(slot.value) : next
    if (value !== slot.value) {
      slot.value = value
      dirty = true
    }
  }
  return [slot.value, set]
}

function useEffect(callback, deps) {
  const index = hookIndex++
  const slot = hooks[index] || (hooks[index] = { deps: undefined, cleanup: undefined })
  const changed =
    !slot.deps || !deps || deps.length !== slot.deps.length || deps.some((d, i) => d !== slot.deps[i])
  if (changed) {
    slot.deps = deps
    effectQueue.push(() => {
      if (typeof slot.cleanup === 'function') slot.cleanup()
      const cleanup = callback()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    })
  }
}

function useCallback(callback, deps) {
  const index = hookIndex++
  const slot = hooks[index] || (hooks[index] = { deps: undefined, callback })
  const changed =
    !slot.deps || !deps || deps.length !== slot.deps.length || deps.some((d, i) => d !== slot.deps[i])
  if (changed) {
    slot.deps = deps
    slot.callback = callback
  }
  return slot.callback
}

const MiniReact = { createElement, Fragment, useState, useEffect, useCallback }

/* --------------------------------------------------------------- fixtures */

const LEDGER = {
  ok: true,
  enabled: true,
  settings: { wordsPerTurn: 2, tokenCapPerWord: 4000, growthEveryTurns: 8, themes: ['自由', '自然', '器物'] },
  totals: { words: 3, turns: 42, tokens: 128400, ms: 3_900_000, flashes: 40, updatedAt: Date.now() },
  current: { turn: 43, words: ['雨', '铜锈'], tokens: 5120, ms: 2400 },
  recent: [
    { at: Date.now() - 60000, turn: 43, words: ['雨', '铜锈'], tokens: 8000, ms: 2400 },
    { at: Date.now() - 120000, turn: 42, words: ['站台', '耳语'], tokens: 8000, ms: 1800 },
  ],
  words: [
    { word: '雨', theme: '自然', tokens: 96400, ms: 2_400_000, visits: 21, dwells: 2, thought: '雨落在铁皮上会放大成噪声', last: Date.now() - 60000, interest: 1 },
    { word: '铜锈', theme: '器物', tokens: 22000, ms: 900_000, visits: 11, dwells: 0, thought: '', last: Date.now() - 60000, interest: 0.62 },
    { word: '耳语', theme: '语言', tokens: 10000, ms: 600_000, visits: 10, dwells: 0, thought: '', last: Date.now() - 120000, interest: 0.4 },
  ],
}

const requests = []
globalThis.fetch = async (url, init) => {
  requests.push({ url, method: (init && init.method) || 'GET' })
  return {
    ok: true,
    status: 200,
    async json() {
      if (String(url).endsWith('/add')) return { ok: true, word: '萤火虫' }
      if (String(url).endsWith('/dwell')) return { ok: true }
      return LEDGER
    },
  }
}
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN' },
  configurable: true,
  writable: true,
})

/* ------------------------------------------------------- module + render */

const fail = []
let definition
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      definition = entry
    },
  },
}

// 执行 client.js（它只调用 window.__ModuleLoader__.load）
new Function('window', source)(globalThis.window)

if (!definition) {
  console.error('FAIL: client.js 没有注册模块')
  process.exit(1)
}
if (definition.id !== 'dsh-feiyu-curiosity') fail.push('模块 id 与包名不一致：' + definition.id)
if (typeof definition.factory !== 'function') fail.push('factory 不是函数')

const requireStub = (name) => {
  if (name === 'react') return MiniReact
  throw new Error('unexpected require: ' + name)
}

const plugin = definition.factory(requireStub)
if (!plugin || typeof plugin.apply !== 'function') fail.push('factory 没有返回带 apply 的插件')
if (!Array.isArray(plugin.inject) || !plugin.inject.includes('slots')) fail.push('inject 里缺少 slots')

const registrations = []
const injections = []
const fakeCtx = {
  get: (name) => (name === 'locale' ? undefined : undefined),
  slots: {
    inject: (key, callback) => {
      injections.push({ key, callback })
      return () => {}
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

plugin.apply(fakeCtx)

if (injections.length !== 3) fail.push('应当注入 3 个槽位，实际 ' + injections.length)
for (const injection of injections) {
  const disposers = injection.callback() || []
  if (!Array.isArray(disposers)) fail.push('inject(' + injection.key + ') 的回调应当返回 disposer 数组')
}

const mainReg = registrations.find((r) => r.options.name === 'main')
const sideReg = registrations.find((r) => r.options.name === 'sidebar.panellist')
if (!mainReg) fail.push('没有注册 main 面板')
else if (mainReg.options.key !== 'feiyu-curiosity') fail.push('main key 不对：' + mainReg.options.key)
if (!sideReg) fail.push('没有注册 sidebar.panellist')
else {
  if (sideReg.options.id !== 'feiyu-curiosity') fail.push('侧栏 id 不对：' + sideReg.options.id)
  const label = typeof sideReg.options.label === 'function' ? sideReg.options.label() : sideReg.options.label
  if (label !== '好奇心') fail.push('侧栏 label 不对：' + label)
}

const footReg = registrations.find((r) => r.options.name === 'sidebar.footer.action')
if (!footReg) fail.push('没有注册 sidebar.footer.action')
else {
  if (footReg.options.id !== 'feiyu-curiosity') fail.push('底部入口 id 不对：' + footReg.options.id)
  if (typeof footReg.component !== 'function') fail.push('底部入口组件不是函数')
  else {
    hookIndex = 0
    const footTree = footReg.component({})
    const footText = serialize(footTree)
    if (!footText.includes('svg') && !(footTree.props && footTree.props.children)) fail.push('底部入口没渲染出图标按钮')
  }
}

// 迷你 hook 运行时：渲染 → 等异步 → 再渲染，直到稳定。
function render(Component) {
  hooks = []
  hookIndex = 0
  lazyEffects = []
  return Component({})
}

let lazyEffects = []
function mount(Component) {
  hooks = []
  effectQueue = []
  let tree
  for (let pass = 0; pass < 6; pass += 1) {
    hookIndex = 0
    dirty = false
    tree = Component({})
    const queue = effectQueue
    effectQueue = []
    for (const run of queue) run()
    if (!dirty) break
    // 让 setData 里的异步继续跑完再下一轮
    awaitTick()
  }
  return tree
}
function awaitTick() {
  const deadline = Date.now() + 200
  while (Date.now() < deadline) {
    // 主动让出事件循环（fetch 的 promise 链需要一次微/宏任务）
  }
}

function serialize(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(serialize).join('')
  if (node.type === Fragment) return node.props.children.map(serialize).join('')
  if (typeof node.type === 'function') return serialize(node.type(node.props))
  const children = (node.props.children || []).map(serialize).join('')
  if (node.type === 'style') return ''
  return children
}

// 第一趟：拿初始渲染（此时 fetch 还没完成）
let tree = render(mainReg.component)
const firstPass = serialize(tree)
if (!firstPass.includes('好奇心')) fail.push('标题没渲染出来')
if (!firstPass.includes('正在翻账本')) fail.push('首帧应当显示加载态')

// 用真实 hook 运行时挂载，等 fetch 落地后检查数据渲染
async function mountAsync(Component) {
  hooks = []
  effectQueue = []
  let out
  for (let pass = 0; pass < 8; pass += 1) {
    hookIndex = 0
    dirty = false
    out = Component({})
    const queue = effectQueue
    effectQueue = []
    for (const run of queue) run()
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (!dirty) break
  }
  return out
}

const mounted = await mountAsync(mainReg.component)
const text = serialize(mounted)
const expect = [
  '好奇心',
  '词数',
  '回合',
  '42',
  '12.8万',
  '此刻闪过的词',
  '第 43 回合',
  '兴趣榜',
  '雨',
  '铜锈',
  '耳语',
  '多想一会儿',
  '最近闪过',
  '计分方式',
  '雨落在铁皮上会放大成噪声',
]
for (const needle of expect) {
  if (!text.includes(needle)) fail.push('面板缺少文案/数据：' + needle)
}
if (requests.filter((r) => r.url.endsWith('/state')).length === 0) fail.push('没有请求 /state')

// 侧栏图标：能渲染、尺寸跟 props 走
const iconTree = sideReg.component({ size: 18, active: true })
const iconText = serialize(iconTree)
if (!iconText.includes('svg') && iconTree.type !== 'svg') fail.push('图标没有渲染成 svg')
if (!iconTree.props || iconTree.props.width !== 18) fail.push('图标没有使用 size prop')

if (fail.length) {
  console.error('FAIL:')
  for (const line of fail) console.error(' - ' + line)
  process.exit(1)
}
console.log('槽位注册:', registrations.map((r) => r.options.name + (r.options.key ? '#' + r.options.key : '#' + r.options.id)).join(', '))
console.log('侧栏 label:', typeof sideReg.options.label === 'function' ? sideReg.options.label() : sideReg.options.label, '| order:', sideReg.options.order)
console.log('面板首屏文本长度:', text.length)
console.log('请求记录:', requests.map((r) => r.method + ' ' + r.url).join(' | '))
console.log('\nOK: 槽位注册 / 加载态 / 数据渲染 / 图标 全部通过')
// 组件里的轮询 interval 会留住进程，测完直接退。
process.exit(0)
