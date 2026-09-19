# JevVSPolymarket

*Jev vs Polymarket — Jev 大战 Polymarket*

English · [中文（展开阅读）](#chinese)

## The experiment

Give Jev a settled Polymarket sports or esports question, withhold the explicit answer and prices, and ask for a probability distribution. Score that distribution against the resolved outcome, then compare it with a historical market-price baseline.

This is a recreational experiment about probability judgments: can Jev beat the market, and does asking the same question again change its answer? The batch experiment reuses a fixed set of markets and cached market baselines within each run. It does not place trades.

## Results and takeaways

The latest recorded repeat test used **100 markets × 5 repeats**, producing **500 successful judgments and no errors**, with model **jev-1.13.0**.

| Measurement | Recorded result | Scope |
| --- | ---: | --- |
| Jev accuracy | 70.4% | All 500 judgments |
| Jev mean Brier | 0.436156 | All 500 judgments |
| Uniform-distribution Brier | 0.500000 | Reference score for [0.5, 0.5] |
| Jev mean Brier, comparable subset | 0.443559 | 98 markets × 5 repeats = 490 judgments |
| Market mean Brier, same subset | 0.423443 | Same 490 judgments |
| Jev lower-Brier judgments | 311 / 490 | Strict wins; ties excluded |
| Accuracy across repeats | 70%, 71%, 71%, 70%, 70% | 100 judgments per repeat |
| Accuracy standard deviation | 0.49 percentage points | Population SD across five repeats |

**The market wins on average Brier in the comparable subset.** Jev beats the uniform-distribution reference and has a lower Brier on many individual judgments, but its larger errors outweigh those wins. Repeat-level results vary little on this sample; that does not establish generalization, calibration, or profitability.

Earlier work completed the first 100-market batch and improved historical baseline coverage from 69 to 98 markets after a time-window repair. Background ablation is implemented but has no recorded results yet.

Table values are rounded for readability. Exact values, per-repeat results, earlier runs and source links are in the [experiment log (Chinese)](docs/experiment-log.md) and the [repeat-test summary](data/jev-batch-2026-09-19T00-24-38-236Z-summary.json).

This is a retrospective comparison, not a leak-free prospective benchmark: descriptions come from the current API, and Jev may already know historical events. Also, the baseline cutoff is relative to the API's endDate, which is not guaranteed to be the match start time.

## Run it

Requires Node.js 20+, pnpm, network access and a TypeSafe API key. In PowerShell:

~~~powershell
Set-Location 'F:\Workspace\JevVSPolymarket'
pnpm install
pnpm typecheck
$env:TYPESAFE_API_KEY = "ts_your_key_here"
~~~

The value above is a placeholder. **Supply the API key only through the TYPESAFE_API_KEY environment variable**, set in your local shell or injected by a secret manager. Never put a real key in source, documentation, data or commits. [.env.example](.env.example) documents the variable; the scripts do not automatically load .env.

The SDK defaults to jev-latest. Optionally set the model:

~~~powershell
$env:TYPESAFE_DEFAULT_MODEL = "jev-latest"
~~~

Check model / jevModel in the output for the actual returned version. Jev calls may incur charges.

### One historical batch

~~~powershell
$env:JEV_BATCH_COUNT = "100"
$env:JEV_BATCH_REPEATS = "1"
$env:JEV_BATCH_BACKGROUND_MODES = "generic"
$env:JEV_BATCH_CONCURRENCY = "5"
pnpm batch:historical
~~~

Each run writes data/jev-batch-<run-id>.jsonl and a matching -summary.json. JSONL includes successful and failed judgments; a summary's existence alone does not mean the run succeeded.

### Fixed-sample repeat test

~~~powershell
$env:JEV_BATCH_COUNT = "100"
$env:JEV_BATCH_REPEATS = "5"
$env:JEV_BATCH_BACKGROUND_MODES = "generic"
$env:JEV_BATCH_CONCURRENCY = "5"
pnpm batch:historical
~~~

Markets are selected once and baselines cached once per process. Five repeats give 500 judgments on 100 markets, not 500 independent markets. A fresh process fetches and selects again; there is no saved-JSONL sample replay entry point.

### Background ablation

~~~powershell
$env:JEV_BATCH_COUNT = "100"
$env:JEV_BATCH_REPEATS = "1"
$env:JEV_BATCH_BACKGROUND_MODES = "bare,generic,sports_prior,calibrated"
$env:JEV_BATCH_CONCURRENCY = "5"
pnpm batch:historical
~~~

| Mode | Background framing |
| --- | --- |
| bare | States that no additional background is provided |
| generic | General historical-evaluation framing |
| sports_prior | Suggests strength, form, roster, venue and format considerations without adding facts |
| calibrated | Emphasizes caution when evidence is missing |

All modes share markets and cached baselines. This measures framing effects, not the benefit of real pre-event intelligence. The configuration above makes 400 judgments; five repeats would make 2,000. PowerShell variables persist within the session, so explicitly reset repeat counts and modes when switching experiments.

### Single-market snapshots

~~~powershell
pnpm start
pnpm analyze
~~~

[src/polymarket-jev.ts](src/polymarket-jev.ts) currently configures one CS2 market, cs2-ace1-bbp-2026-01-23, in MARKET_CONFIGS. The supplied background excludes odds, roster status, map veto and recent form.

start fetches market data, calls Jev and appends to data/jev-snapshots.jsonl. Prices are saved for comparison but excluded from Jev's input. analyze reads snapshots and refreshes settlement status online without calling Jev or requiring its key.

If the market was already settled when captured, its snapshot price is not a predictive baseline. Repeated snapshots count as additional records, not independent markets. MARKET_CONFIGS can be edited for other markets, which must have exactly two outcomes.

## Method details

### Inputs and sampling

The scripts fetch data from Polymarket Gamma. Jev receives the market question, resolution rule, background and deadline, with two outcome options. Explicit final-result and price fields are withheld. The outputs retain choice, probabilities, confidence, actual model version, latency and input token count.

[src/batch-historical-jev.ts](src/batch-historical-jev.ts) selects closed binary markets with a terminal winning price of at least 0.999, the other price at most 0.001, and sufficient volume. Terminal prices identify the scoring target only.

Candidates are grouped heuristically by question title, sorted by volume within groups and selected round-robin across groups. This is exploratory selection, not random or representative sampling. Current descriptions are not reconstructed as of a historical date or scrubbed for post-event wording.

### Historical market baseline

The script queries CLOB prices-history for the first outcome token and takes the last point at or before endDate minus the lead time, constructing [p, 1-p].

If startDate is invalid or not earlier than endDate, the query starts seven days before endDate. If the preferred cutoff is unusable or has no price, the script tries a cutoff at endDate and marks event_end_fallback; the preferred mode is lead_time. Repairing the query start and falling back on the cutoff are different operations.

JSONL records the price timestamp, cutoff, mode or missing-baseline reason. endDate need not be kickoff, and the last historical point need not be close to the cutoff. These are API-time-based historical baselines, not guaranteed pre-match odds.

### Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| JEV_BATCH_COUNT | 100 | Target market count |
| JEV_BATCH_REPEATS | 1 | Repeats per background mode |
| JEV_BATCH_BACKGROUND_MODES | generic | Comma-separated modes |
| JEV_BATCH_CONCURRENCY | 5 | Worker concurrency |
| JEV_BATCH_MAX_PAGES | 20 | Maximum pages, 100 records each |
| JEV_BATCH_MIN_VOLUME | 50 | Minimum volume filter |
| JEV_BATCH_PRE_EVENT_LEAD_SECONDS | 3600 | Seconds before endDate |
| POLYMARKET_SPORTS_TAG_ID | 100639 | Gamma sports tag |

### Metrics and denominators

| Field | Meaning |
| --- | --- |
| accuracy | Fraction of successful judgments with the correct Jev choice |
| meanBrier | Mean of (pA-yA)² + (pB-yB)²; range 0–2, lower is better |
| uniformBaselineBrier | 0.5 for [0.5, 0.5]; not a measured accuracy |
| meanProbabilityOfActual | Mean probability assigned to the resolved outcome |
| highConfidenceWrong | Wrong choice with SDK confidence at least 0.7 |
| marketAccuracy | Fraction of comparable records where market probability of the actual outcome is at least 0.5; ties count as correct |
| marketMeanBrier | Market Brier on successful Jev records with a baseline |
| jevMeanBrierOnMarketComparable | Jev Brier on that same subset |
| jevBrierWinsAgainstMarket | Strict per-record Brier wins; ties excluded |
| successfulCount / errorCount | Successful / failed judgments |

Compare Brier on the same subset. Market accuracy counts 0.5 ties as correct, unlike Jev's single-choice rule. The two-component Brier must not be mixed with a one-component 0–1 convention. If every call fails, some means are written as zero; that is not perfect performance.

In the current summary, top-level marketBaselineCount counts unique markets, while overall scores aggregate judgments across repeats and modes. repeatSummaries and repeatAggregate describe the first background mode; other modes appear in ablationSummaries. The repeat SD is a population SD, not a confidence interval. byFamily covers the first mode's first repeat and uses title heuristics, not rigorous sports categories. Older summaries have different scope labels.

## Boundaries

- No trades, wallets, private keys or trading authorization are required. This is not investment advice.
- Do not include secrets or private information in backgrounds sent to TypeSafe.
- Historical selection bias, correlated events, model memory and post-event text can affect results. Current results do not establish prospective skill or statistical significance.
- Fees, slippage and returns are not modeled; prediction scores do not demonstrate a profitable strategy.
- APIs, descriptions, historical prices and model aliases may change. Bind conclusions to saved records and actual model versions.

<a id="chinese"></a>

<details>
<summary>中文说明：Jev 大战 Polymarket（点击展开）</summary>

## 方法简介

给 Jev 一道已结算的 Polymarket 体育／电竞问题，不单独传入最终答案和市场价格，让它输出概率分布，再按实际结果评分，与历史市场价格比较。同一次批量进程复用固定市场和缓存基线，观察重复判断是否稳定。

这是一个娱乐性质的概率实验，不执行交易。

## 实验结果与结论

最新记录使用 jev-1.13.0，对 100 个市场重复判断 5 次，共 500 次成功、0 次失败。

| 指标 | 结果 | 统计范围 |
| --- | ---: | --- |
| Jev 准确率 | 70.4% | 全部 500 次判断 |
| Jev 平均 Brier | 0.436156 | 全部 500 次判断 |
| 均匀分布 Brier | 0.500000 | [0.5, 0.5] 参考分数 |
| Jev 同子集平均 Brier | 0.443559 | 98 个市场 × 5 次 = 490 次判断 |
| 市场同子集平均 Brier | 0.423443 | 相同 490 次判断 |
| Jev 单条 Brier 胜出 | 311 / 490 | 严格更低，平局不计 |
| 5 轮准确率 | 70%、71%、71%、70%、70% | 每轮 100 次 |
| 准确率总体标准差 | 约 0.49 个百分点 | 5 轮之间 |

**市场在可比较子集的平均 Brier 上获胜。** Jev 的整体 Brier 好于均匀分布参考，且在不少单题上优于市场，但较严重的错误抵消了这些优势。这批样本的轮间汇总波动较小，不能据此证明泛化、校准或盈利能力。

此前已完成首次 100 市场批量测试，并通过时间窗口修复将市场基线覆盖率从 69/100 提升至 98/100。背景消融已实现，尚无记录结果。

表中数值为便于阅读而四舍五入；精确数值、逐轮明细及来源见[实验记录](docs/experiment-log.md)和[重复测试 summary](data/jev-batch-2026-09-19T00-24-38-236Z-summary.json)。历史描述和模型已有知识可能带来信息泄漏，endDate 也未必是开赛时间，因此这不是已排除泄漏的前瞻评测。

## 运行环境与密钥

需要 Node.js 20+、pnpm、网络连接及 TypeSafe API key。在 PowerShell 中运行：

~~~powershell
Set-Location 'F:\Workspace\JevVSPolymarket'
pnpm install
pnpm typecheck
$env:TYPESAFE_API_KEY = "ts_your_key_here"
~~~

示例值只是占位符。**API key 只通过环境变量 TYPESAFE_API_KEY 提供**，由本地 shell 设置或 secret manager 注入；不要把真实值写入源码、文档、数据或提交记录。[.env.example](.env.example) 只说明变量，当前脚本不会自动加载 .env。

SDK 默认模型为 jev-latest，可选设置：

~~~powershell
$env:TYPESAFE_DEFAULT_MODEL = "jev-latest"
~~~

实际模型版本以结果文件中的 model／jevModel 为准。调用 Jev 可能产生费用；并发、样本数、重复次数和背景数共同决定请求规模。

## 单市场快照与分析

~~~powershell
pnpm start
pnpm analyze
~~~

[src/polymarket-jev.ts](src/polymarket-jev.ts) 的 MARKET_CONFIGS 当前只配置一个 CS2 市场 cs2-ace1-bbp-2026-01-23，背景明确没有赔率、阵容、地图选择或近期状态数据。以后可在该配置中更换 slug 和背景，市场必须恰有两个结果。

start 联网取市场信息并调用 Jev，追加到 data/jev-snapshots.jsonl；市场价格仅保存在快照中用于比较。analyze 读取快照、联网刷新结算状态，报告实际结果、双方给实际结果的概率和 Brier；它不调用 Jev，也不需要 TypeSafe API key。

若采集快照时市场已结算，保存的价格不是预测基线。重复运行同一个市场会追加多条快照，分析按快照计数，不代表新增独立市场。

## 历史批量测试

运行一次 100 个市场的通用背景测试：

~~~powershell
$env:JEV_BATCH_COUNT = "100"
$env:JEV_BATCH_REPEATS = "1"
$env:JEV_BATCH_BACKGROUND_MODES = "generic"
$env:JEV_BATCH_CONCURRENCY = "5"
pnpm batch:historical
~~~

[src/batch-historical-jev.ts](src/batch-historical-jev.ts) 筛选 closed 为 true、二元、胜方终局价格至少 0.999、另一方至多 0.001 且成交量达标的市场。终局价格用于识别评分答案，不作为预测基线。

选样按问题标题启发式分组，组内按成交量降序，组间轮流取样。它是探索性筛选，不是随机或代表性抽样。每次进程生成：

~~~text
data/jev-batch-<run-id>.jsonl
data/jev-batch-<run-id>-summary.json
~~~

JSONL 保存成功和失败记录；summary 汇总指标。失败判断不参与准确率，不能仅凭文件存在就认定实验成功。

### 固定样本重复稳定性

~~~powershell
$env:JEV_BATCH_COUNT = "100"
$env:JEV_BATCH_REPEATS = "5"
$env:JEV_BATCH_BACKGROUND_MODES = "generic"
$env:JEV_BATCH_CONCURRENCY = "5"
pnpm batch:historical
~~~

同一次进程只选一次市场、缓存一次市场基线，然后重复调用 Jev。100 个市场 × 5 次是 500 次判断，仍只有 100 个独立市场。summary 的 repeatSummaries 给出逐轮结果，repeatAggregate 给出轮间均值和总体标准差（除以轮数）。

“固定”仅限本次进程。重新执行命令会重新获取和选择市场，当前没有读取旧 JSONL 来重放样本的入口。重复测试能衡量这批输入的波动，不能证明泛化能力。

### 背景消融：换一种问法会怎样？

~~~powershell
$env:JEV_BATCH_COUNT = "100"
$env:JEV_BATCH_REPEATS = "1"
$env:JEV_BATCH_BACKGROUND_MODES = "bare,generic,sports_prior,calibrated"
$env:JEV_BATCH_CONCURRENCY = "5"
pnpm batch:historical
~~~

| 模式 | 提供的背景 |
| --- | --- |
| bare | 仅说明没有额外背景 |
| generic | 通用历史市场评估说明 |
| sports_prior | 提醒考虑实力、近期状态、阵容、场地和赛制，但不添加事实 |
| calibrated | 强调证据不足时保持谨慎，避免制造确定性 |

四种模式共用市场与缓存基线，结果在 ablationSummaries 中。以上配置为 400 次判断；再设 5 次重复就是 2,000 次。这测量的是提示框架影响，不是加入真实赛前情报的收益。截至已核对的实验文件，尚无背景消融结果。

PowerShell 环境变量会保留在当前会话中，切换实验时请明确重设重复次数与背景模式。

### 批量参数与市场基线

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| JEV_BATCH_COUNT | 100 | 目标市场数 |
| JEV_BATCH_REPEATS | 1 | 每种背景的重复次数 |
| JEV_BATCH_BACKGROUND_MODES | generic | 逗号分隔的背景模式 |
| JEV_BATCH_CONCURRENCY | 5 | 并发工作数 |
| JEV_BATCH_MAX_PAGES | 20 | 最多获取页数，每页 100 条 |
| JEV_BATCH_MIN_VOLUME | 50 | 最低成交量筛选值 |
| JEV_BATCH_PRE_EVENT_LEAD_SECONDS | 3600 | 相对 endDate 提前的秒数 |
| POLYMARKET_SPORTS_TAG_ID | 100639 | Gamma 体育标签 |

基线查询第一个 outcome token 的 CLOB prices-history，取不晚于 endDate 减去提前量的最后一个历史点，构造 [p, 1-p] 分布。若 startDate 无效或不早于 endDate，查询起点改为 endDate 前 7 天。

若提前窗口不可用或没有价格，脚本再尝试截至 endDate 的窗口，标记 event_end_fallback；正常提前窗口标记 lead_time。查询起点修正与截止点回退是两种不同操作。JSONL 保存价格时间、截止时间、模式或缺失原因。

endDate 未必是赛事开赛时间，最后一个历史点也未必紧贴截止点。因此它是按 API 时间构造的历史基线，不能笼统称为严格赛前赔率；最终结算价格不能替代它。

## 数据怎样流动

1. 从 Polymarket Gamma API 获取市场问题、规则、选项、日期和价格。
2. 单次入口使用手工配置的市场；历史批量入口筛选已结算的二元体育／电竞市场。
3. 向 TypeSafe 的 Jev 发送问题、结算规则、背景和截止时间，并提供两个结果选项。市场价格和最终结果不作为单独字段发送。
4. 保存 Jev 的选择、概率、置信度、实际模型版本、延迟和输入 token 数。
5. 用识别出的结算结果评分；历史批量另取 CLOB 历史价格建立市场基线。
6. 保存 JSONL 明细和批量 summary，供比较、重复稳定性及背景消融分析。

“隐藏答案”有边界：规则描述直接取自当前 API，没有还原历史版本或清洗其中可能出现的赛后文字；模型也可能已有赛事知识。提示词要求忽略结果，不等于已证明不存在信息泄漏。

## 怎样看指标

| 指标 | 含义与注意点 |
| --- | --- |
| accuracy | 成功判断中 Jev 选对结果的比例 |
| meanBrier | 双分量平方误差之和的均值：(pA-yA)² + (pB-yB)²；范围 0–2，越低越好 |
| uniformBaselineBrier | 均匀分布 [0.5, 0.5] 的 Brier 恒为 0.5，不是实测准确率 |
| meanProbabilityOfActual | 分配给实际结果的平均概率，越高表示给正确结果的概率越多 |
| highConfidenceWrong | 选择错误且 SDK 返回置信度至少 0.7 的次数 |
| marketAccuracy | 可比较记录中市场给实际结果的概率至少 0.5 的比例；恰好 0.5 也计正确 |
| marketMeanBrier | 有市场基线且 Jev 调用成功的子集上的市场平均 Brier |
| jevMeanBrierOnMarketComparable | Jev 在同一子集上的平均 Brier，应使用它与市场比较 |
| jevBrierWinsAgainstMarket | Jev 单条 Brier 严格小于市场的次数，平局不算胜 |
| successfulCount / errorCount | 成功／失败判断数；全部失败时部分均值写为 0，不代表完美表现 |

Brier 使用两个分量，不能与只算一个分量的 0–1 口径直接混用。赢的题数多也不保证平均 Brier 更低，因为严重错误的惩罚更重。

当前 summary 顶层 marketBaselineCount 是独立市场数；整体分数按所有成功判断汇总。repeatSummaries 和 repeatAggregate 对应第一种背景，其他模式见 ablationSummaries。byFamily 只统计第一种背景的第一轮，标题分组不是严格的运动类别。旧 summary 的字段和作用域标签可能不同，应按原文件解释。

## 安全与解释边界

- 只做模型实验，不下单，不需要钱包、私钥或交易授权，不提供投资建议。
- 发给 TypeSafe 的是市场问题、规则、选项、背景及日期；不要在手工背景中放入秘密或私人信息。
- 历史数据可能有选择偏差、赛事相关性、模型记忆和赛后文字影响；当前结果不是实时预测或统计显著性的证明。
- 未计算手续费、滑点和收益，准确率或 Brier 优势不等于可交易利润。
- API 返回、市场规则、历史价格及模型别名可能变化；结论应绑定保存的 JSONL、summary 和实际模型版本。

</details>
