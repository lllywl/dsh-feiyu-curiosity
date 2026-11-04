# dsh-feiyu-curiosity · 好奇心

> 给 DeepSeek Harness 的 Agent 装一个「自己长出来的兴趣账本」。
> 每回合随机闪过几颗词，把这一回合**真实消耗**的 token 和时间记到它们头上；
> 想得越多的词越接近它真正感兴趣的东西，于是下一次更容易被想到。
>
> An interest ledger for a DeepSeek Harness agent: a few random words surface each turn,
> the tokens and time that turn really cost are credited to them, and the words it keeps
> dwelling on come back more often — a small, local, self-growing preference.

---

## 为什么

大多数「人格」是静态提示词写死的。这个插件换个思路：**让偏好从开销里长出来**。

- 不额外调用模型：记分只读本回合已经发生的 `usage`，不产生新的请求。
- 不靠随机数骗人：词被想到时，这个回合真实花掉的 token 会按比例记进去。
- 会自己聚成团：一颗词热起来，同主题的邻居词自动进池，兴趣会连成片而不是散点。
- 全程本地：词和思考都在 `$DSH_HOME/curiosity/state.json`，不上传。

## 它怎么工作

1. **闪词**：`turn/start` 时按热度加权抽 `wordsPerTurn` 颗词（默认 2）。近期刚出现过的降权，没被想过的加权。
2. **进入脑子**：闪过的词以一行「余光」进入本回合的系统提示词（`curiosity:flash` 段）。它只是背景，不要求写进回答——写不写随 Agent。
3. **按真实开销记分**：`turn/end` 时把本回合所有 `assistant/message.usage` 累加，取 `tokenShare`（默认 2%）按词均分，单颗词每回合封顶 `tokenCapPerWord`（默认 4000）；时长用 `turn/end.time - turn/start.time` 均分。
   > 为什么要 `tokenShare`：只按均分的话，任何长回合都会顶到上限，兴趣值就退化成「被闪过几次」。乘 2% 让短回合轻微、长回合值钱。
4. **主动加餐**：`curiosity` 工具。
   - `peek`：看此刻闪过的词、热度榜、账本总量。
   - `dwell`：对某颗词记一笔思考，按字数额外记账（上限 600 token / 24 秒）。
5. **长成一片**：一颗词被想满 3 / 8 / 16 次时，同主题邻居自动进池；每 `growthEveryTurns` 回合补一颗全新词。池上限 220 颗。

兴趣分：`0.5·log(1+tokens) + 0.3·log(1+秒) + 0.4·log(1+被想次数)`，按最高分归一化成面板里的进度条。

## 界面

- **侧栏面板图标**（`sidebar.panellist`，order 30）——和其它全局面板并列。
- **侧栏底部入口**（`sidebar.footer.action`）——设置齿轮旁边，侧栏折叠时也在。
- **主面板**（`main` key = `feiyu-curiosity`）：四格统计 → 此刻闪过的词 → 往词池加词 → 兴趣榜（可点「多想一会儿」）→ 最近闪过。

面板文字全中文，颜色全部走宿主 `--dsw-alias-*` 主题变量，深色/浅色自动跟随。

## 安装

```bash
# 方式一：从 npm
dsh plugin add dsh-feiyu-curiosity

# 方式二：本地目录（开发时）
# 在 DSH 的插件管理里选择「安装本地目录」，指向本仓库根目录
```

安装后自动写入 profile 的 bundle 清单，**所有会话、重启后都生效**。

## 配置

写在 profile 的 `cordis.patch.yml`：

```yaml
- id: feiyu-curiosity
  name: 'dsh-feiyu-curiosity'
  config:
    enabled: true            # false = 只留面板看数据，不闪词不计分
    wordsPerTurn: 2          # 每回合闪几颗（0-6）
    tokenShare: 0.02         # 每颗词每回合分走本回合 token 的比例
    tokenCapPerWord: 4000    # 单颗词单回合封顶
    growthEveryTurns: 8      # 每几回合补一颗新词
    seedWords: 12            # 首次初始化放多少颗种子词
    excludeSubagents: true   # 子代理回合不计分（避免同一笔活记两遍）
    sectionOrder: 900        # 系统提示词里「余光」段的位置
```

## 数据

`$DSH_HOME/curiosity/state.json`（Linux/macOS 通常是 `~/.dsh/curiosity/state.json`）。

- 回合结束立即落盘；其余改动 800ms 节流写入；插件卸载时兜底 flush。
- 删掉这个文件 = 从零开始的好奇心（种子词会重新抽 12 颗）。
- 文件里只有：词、主题、token/时长/次数、最近一次思考的文本。没有对话内容。

## HTTP 接口

面板用，仅 `127.0.0.1` 且同源（拒绝 `sec-fetch-site: cross-site`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/feiyu-curiosity/state` | 账本快照 |
| POST | `/api/feiyu-curiosity/add` | `{ word, theme }` 往词池加一颗 |
| POST | `/api/feiyu-curiosity/dwell` | `{ word }` 手动让 Agent 多想一会儿（+400 token / +3 秒） |

## 自测

不需要 Harness，也不需要装 React：

```bash
node test/curiosity-sim.mjs    # Host：闪词 → 计分 → 落盘 → 工具 → 路由（含封顶与非本机拒绝）
node test/client-sim.mjs       # Client：迷你 React 跑槽位注册、加载态、数据渲染、图标
```

两个脚本都会在临时目录里造账本，不碰你的真数据。

## 成本

- 每回合多一行「余光」：约 45 token。
- `curiosity` 工具定义常驻请求：约 150 token。
- 记分本身：**零额外模型请求**。

嫌贵就把 `wordsPerTurn` 调到 1，或者 `enabled: false`。

## 邻居项目

- [`JMX-4869/dsh-mood`](https://github.com/JMX-4869/dsh-mood)：给 DSH 加「心情」，靠状态机自己漂移。
- [`hello-yunshu/interest-growth`](https://github.com/hello-yunshu/interest-growth)：面向人的兴趣培养方法论，不是插件。
- [`fuyiyun666/awesome-dsh-plugin-2`](https://github.com/fuyiyun666/awesome-dsh-plugin-2)：DSH 插件索引。

好奇心和心情是两回事：心情是「现在什么感觉」，这个插件是「长期在想什么」。

## License

MIT
