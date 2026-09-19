# 实验记录：Jev 大战 Polymarket

本记录依据仓库现有 JSON summary 与对应 JSONL 整理，核对日期为 2026-09-19。下表直接保留 summary 的数值精度；百分比是相应比例的换算。runId 使用 UTC，不能把文件名时间直接当作北京时间。

这些是历史回顾实验。最终结果和价格不作为单独字段发给 Jev，但当前市场描述与模型知识可能包含历史信息；不能称为已排除泄漏的前瞻验证。运行方法和指标定义见 [README](../README.md)。

## 1. 单次批量已经跑通

来源：[首次成功 summary](../data/jev-batch-2026-09-18T16-54-41-874Z-summary.json) · [JSONL](../data/jev-batch-2026-09-18T16-54-41-874Z.jsonl)。

| 字段 | 原始结果 |
| --- | ---: |
| selectedCount | 100 |
| successfulCount | 100 |
| errorCount | 0 |
| accuracy | 0.7 |
| meanBrier | 0.4328640000000003 |
| meanProbabilityOfActual | 0.6424 |
| highConfidenceWrong | 7 |
| uniformBaselineBrier | 0.5 |

该次验证了市场发现、Jev 判断、明细保存与评分流程。summary 尚无市场基线指标，因此只支持与均匀分布的 Brier 比较，不能据此声称打败市场。

更早的 [12-27 批次](../data/jev-batch-2026-09-18T12-27-09-602Z-summary.json) 和 [16-53 批次](../data/jev-batch-2026-09-18T16-53-33-819Z-summary.json) 均为 successfulCount = 0、errorCount = 100、accuracy = null。其 meanBrier = 0 是无成功记录时的汇总值，不纳入模型表现结论；summary 本身不足以确定凭据失败的具体原因。

## 2. 市场基线修复与复测

| 批次（UTC runId） | 成功／失败 | Jev accuracy | Jev meanBrier | 可比较市场数 | 截止点回退数 |
| --- | --- | ---: | ---: | ---: | ---: |
| 2026-09-18T23-44-18-987Z | 100 / 0 | 0.7 | 0.4330219999999999 | 69 | 未记录 |
| 2026-09-18T23-57-25-578Z | 100 / 0 | 0.68 | 0.43392199999999986 | 69 | 0 |
| 2026-09-19T00-04-21-338Z | 100 / 0 | 0.69 | 0.43468599999999996 | 98 | 0 |

来源：

- [23-44 summary](../data/jev-batch-2026-09-18T23-44-18-987Z-summary.json) · [JSONL](../data/jev-batch-2026-09-18T23-44-18-987Z.jsonl)
- [23-57 summary](../data/jev-batch-2026-09-18T23-57-25-578Z-summary.json) · [JSONL](../data/jev-batch-2026-09-18T23-57-25-578Z.jsonl)
- [00-04 summary](../data/jev-batch-2026-09-19T00-04-21-338Z-summary.json) · [JSONL](../data/jev-batch-2026-09-19T00-04-21-338Z.jsonl)

前两份 JSONL 各有 29 条 Invalid historical market time range 和 2 条 No pre-event price history。00-04 批次只剩 2 条 No pre-event price history，可比较市场数从 69 增至 98。

当前代码在 startDate 无效或不早于 endDate 时，使用 endDate 前 7 天作为查询起点，避免直接拒绝这一时间范围。随后仍优先取 endDate 前 3600 秒的历史点；无可用点才尝试截至 endDate 并标记 event_end_fallback。修复后的回退计数为 0，说明查询起点修正不能等同于截止点回退。现有 JSONL 证明错误分布与覆盖率变化，但没有保存完整 Gamma 时间元数据，不能仅凭这些文件断言所有原始错误都是起止日期相等造成的。

修复后的 00-04 批次精确比较：

| 字段 | 原始结果 |
| --- | ---: |
| marketAccuracy | 0.7142857142857143 |
| marketMeanBrier | 0.4234433673469389 |
| jevMeanBrierOnMarketComparable | 0.4418326530612244 |
| jevBrierWinsAgainstMarket | 62 |
| meanProbabilityOfActual | 0.6428999999999999 |
| highConfidenceWrong | 10 |
| preEventLeadSeconds | 3600 |

Jev 在 98 个可比较市场中有 62 个单题 Brier 更低，但同子集的平均 Brier 更高。市场覆盖范围从 69 变成 98 后，不能把不同子集的分数变化当作模型能力的因果变化；不同批次也重新调用了 Jev。

## 3. 100 个固定市场，重复 5 次

来源：[重复测试 summary](../data/jev-batch-2026-09-19T00-24-38-236Z-summary.json) · [JSONL](../data/jev-batch-2026-09-19T00-24-38-236Z.jsonl)。

selectedCount = 100，repeatCount = 5，concurrency = 5，sportsTagId = 100639，minVolume = 50，preEventLeadSeconds = 3600。JSONL 共 500 条，100 个不同 slug；每轮各 100 条。该批 JSONL 返回的模型为 jev-1.13.0。市场选择和基线在本次进程内复用，500 次判断不是 500 个独立样本。

### 每轮结果

| 轮次 | 成功／失败 | accuracy | meanBrier | meanProbabilityOfActual | highConfidenceWrong | Brier 胜市场次数 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 100 / 0 | 0.7 | 0.43680400000000014 | 0.6404000000000003 | 9 | 63 |
| 2 | 100 / 0 | 0.71 | 0.43581999999999993 | 0.6422 | 9 | 62 |
| 3 | 100 / 0 | 0.71 | 0.4401260000000001 | 0.6403000000000002 | 9 | 62 |
| 4 | 100 / 0 | 0.7 | 0.433128 | 0.6429999999999998 | 9 | 62 |
| 5 | 100 / 0 | 0.7 | 0.4349 | 0.6417999999999998 | 8 | 62 |

summary 轮号从 1 开始，JSONL 的 repeat 从 0 开始。每轮有 98 个可比较市场、0 次截止点回退；每轮市场 accuracy 为 0.7142857142857143，meanBrier 为 0.4234433673469389。

### 总体与轮间聚合

| 位置／字段 | 原始结果 |
| --- | ---: |
| 顶层 successfulCount / errorCount | 500 / 0 |
| 顶层 accuracy | 0.704 |
| 顶层 meanBrier | 0.43615560000000014 |
| 顶层 meanProbabilityOfActual | 0.6415400000000001 |
| 顶层 highConfidenceWrong | 44 |
| repeatAggregate.accuracyMean | 0.7040000000000001 |
| repeatAggregate.accuracyStdDev | 0.004898979485566361 |
| repeatAggregate.meanBrierMean | 0.43615560000000003 |
| repeatAggregate.meanBrierStdDev | 0.002325511522224764 |
| repeatAggregate.meanProbabilityOfActualMean | 0.6415400000000001 |
| repeatAggregate.highConfidenceWrongMean | 8.8 |

准确率轮间总体标准差约为 0.49 个百分点。顶层均值与轮均值的末位差异来自浮点求和顺序，以上保留文件原值。这里的标准差描述 5 次重复的波动，不是置信区间。

### 同一子集上的市场比较

| 顶层字段 | 原始结果 |
| --- | ---: |
| uniqueMarketBaselineCount | 98 |
| marketBaselineCount | 98 |
| marketBaselineFallbackCount | 0 |
| marketAccuracy | 0.7142857142857143 |
| marketMeanBrier | 0.423443367346938 |
| jevMeanBrierOnMarketComparable | 0.4435587755102044 |
| jevBrierWinsAgainstMarket | 311 |

98 个独立市场 × 5 次形成 490 次可比较判断；2 个缺基线市场重复后对应 JSONL 中 10 条 No pre-event price history。311 次胜出以 490 次判断为分母，不是 100 或 500。

同子集平均 Brier 显示市场优于 Jev。70.4% 是 Jev 全部 500 次判断的准确率，不能不说明分母就与 98 个市场的市场准确率直接并列比较。市场概率恰好 0.5 时也被代码计为正确，与 Jev 的单选口径有差异。

这批样本的轮间汇总波动较小，但不能据此判断错误来自“稳定先验”，也不能把选择一致性等同于概率校准或泛化能力。该旧 summary 的 byFamilyScope 为 first_repeat_only，仅覆盖第一轮；标题启发式分组不代表严格的体育分类。

## 4. 背景消融：已实现，尚无结果

当前代码支持 bare、generic、sports_prior、calibrated 四种背景，运行命令见 [README](../README.md)。已有 summary 中尚无这四种模式的对照结果，因此不报告消融分数或胜出模式。

后续应在同一批市场、同一基线下比较各模式的 accuracy、meanBrier、highConfidenceWrong 和 jevMeanBrierOnMarketComparable，并通过重复运行观察波动。这里只改变背景表述，不加入真实赛前事实。

## 数据定位与复核

历史 summary 的 resultsPath 仍指向原目录 F:\Workspace\JevPlayground\data。为避免目录迁移影响，本记录使用指向当前仓库 data 的相对链接；没有改写原始数据。

可在当前仓库的 PowerShell 中直接查看记录，不调用 API：

~~~powershell
Set-Location 'F:\Workspace\JevVSPolymarket'
$summary = Get-Content -Raw '.\data\jev-batch-2026-09-19T00-24-38-236Z-summary.json' | ConvertFrom-Json
$summary.repeatSummaries | Format-Table repeat, successfulCount, accuracy, meanBrier, highConfidenceWrong
$summary.repeatAggregate | Format-List
~~~

本次文档整理没有重新运行付费实验；结论仅绑定上面列出的已有文件，不代表实时市场表现。
