# Experiment Log

## Project

`JevVSPolymarket`（Jev 大战 Polymarket）是一个娱乐性质的历史预测实验。目标不是交易，而是观察 Jev 的结构化概率判断和预测市场基线之间的差异。

## Method contract

每条记录包含一个已经结算的二元体育或电竞市场。发送给 Jev 的状态包含：

- 市场问题；
- 结算规则；
- 两个结果选项；
- 实验背景；
- 市场截止时间。

最终结果、终局价格、评论和赛后信息不发送给 Jev。最终结果只在评分阶段使用。

市场基线使用事件截止前一小时的 CLOB 历史价格。Polymarket 的部分历史体育市场把 `startDate` 和 `endDate` 写成相同时间，脚本会使用事件前默认窗口修正这个元数据问题，并保留 baseline mode。

## Completed runs

### Initial batch

早期批量运行验证了端到端流程：Gamma 市场发现、Jev Choice 判断、JSONL 保存和最终结果评分。期间曾出现 API key 缺失/无效导致的 401 运行失败；这些失败记录不作为模型结果使用。

### Single batch after baseline repair

结果文件：

- `data/jev-batch-2026-09-19T00-04-21-338Z-summary.json`
- `data/jev-batch-2026-09-19T00-04-21-338Z.jsonl`

关键结果：

- 100/100 次 Jev 调用成功；
- Jev 准确率 69%；
- Jev 平均 Brier 0.4347；
- 98/100 条有可比较的市场基线；
- 市场准确率 71.43%；
- 市场平均 Brier 0.4234；
- 剩余 2 条缺少可用的 Formula 1 事件前价格历史。

### Fixed-sample repeat test

结果文件：

- `data/jev-batch-2026-09-19T00-24-38-236Z-summary.json`
- `data/jev-batch-2026-09-19T00-24-38-236Z.jsonl`

配置为同一批 100 个市场重复 5 次，共 500 次 Jev 调用。市场基线只读取一次并在重复测试中复用。

summary 中的准确结果：

| Metric | Jev | Market baseline |
| --- | ---: | ---: |
| Mean accuracy | 70.4% | 71.43% |
| Mean Brier | 0.4362 | 0.4234 |
| Brier standard deviation across repeats | 0.0023 | not applicable |
| Comparable baseline markets | 98 | 98 |

逐题分析 JSONL 得到：

- 68 个问题 5 次全部判断正确；
- 28 个问题 5 次全部判断错误；
- 4 个问题出现判断摇摆；
- 平均逐题选择一致性约 99%。

这说明主要问题不是 Jev 的随机输出，而是它对部分题目的稳定错误先验和过度自信。

## Baseline repair note

原始历史基线逻辑把 `eventEnd <= startDate` 视为无效。对不少已结算体育市场，API 返回的 `startDate` 和 `endDate` 相同，但 CLOB 仍然存在事件前历史价格。修复后，脚本在声明的起始时间无效时使用事件结束前 7 天窗口，并优先取事件前一小时的最后价格。

修复后的单次运行从 69/100 条市场基线提升到 98/100 条。剩余缺失记录属于没有可用 CLOB 历史点，而不是时间范围解析错误。

## Next experiment

背景信息消融测试已实现但尚未在本仓库记录结果。运行：

```powershell
$env:JEV_BATCH_COUNT = "100"
$env:JEV_BATCH_REPEATS = "1"
$env:JEV_BATCH_BACKGROUND_MODES = "bare,generic,sports_prior,calibrated"
$env:JEV_BATCH_CONCURRENCY = "5"
pnpm batch:historical
```

这个实验需要比较 `ablationSummaries` 中四种模式的：

1. 准确率；
2. 平均 Brier；
3. 高置信度错误数；
4. Jev 相对于同一市场基线的 Brier 差异。

如果背景模式之间差异明显，再用固定样本重复运行区分真实的背景效果和 Jev 输出随机性。

## Interpretation boundary

当前样本是从已结算的体育/电竞二元市场中筛选出来的探索性样本，不代表 Jev 的普遍能力。`byFamily` 使用标题启发式分组，只适合快速观察，不应视为严格的体育项目分层评测。

任何高置信度错误都应保留在结果中；不能只报告预测正确的市场。
