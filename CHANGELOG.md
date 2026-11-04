# Changelog

## 0.1.0 — 2026-11-04

首个版本。

- **闪词**：每个回合开始时按历史热度加权抽样 `wordsPerTurn` 颗词（默认 2），近期刚出现的降权、没被想过的加权。
- **进入上下文**：闪过的词以一行「余光」进入本回合系统提示词（`curiosity:flash` 段），只是背景，不要求写进回答。
- **按真实消耗记分**：`turn/end` 时把该回合 `assistant/message.usage` 累加，取其 `tokenShare`（默认 2%）按词均分，单颗词每回合封顶 `tokenCapPerWord`（默认 4000）；时长按回合时长均分。
- **主动加餐**：`curiosity` 工具，`peek` 看账本，`dwell` 对某颗词记一笔思考（按字数额外记账）。
- **兴趣会聚成片**：一颗词被想满 3 / 8 / 16 次时，同主题邻居自动进池；每 `growthEveryTurns` 回合补一颗新词，池上限 220 颗。
- **Web 面板**：侧栏图标（`sidebar.panellist`）+ 侧栏底部入口（`sidebar.footer.action`）+ 主面板（`main`）；兴趣榜、加词、多想一会儿、最近闪过。
- **HTTP 接口**：`/api/feiyu-curiosity/{state,add,dwell}`，仅 127.0.0.1 / 同源可访问。
- **离线自测**：`test/curiosity-sim.mjs`（Host 记账链路）与 `test/client-sim.mjs`（迷你 React 跑槽位注册与面板渲染）。
