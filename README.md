# JevVSPolymarket

## Jev 大战 Polymarket

一个娱乐性质的实验：给 Jev 一道已经结算、但隐藏最终结果的 Polymarket 问题，看看模型的概率判断能不能打过市场共识。

它不是交易工具，也不是投资建议。项目的重点是观察模型判断、概率校准、市场基线和背景信息之间的关系。

## 实验流程

1. 从 Polymarket Gamma API 获取已经结算的二元体育/电竞市场。
2. 将最终结果和终局价格从发送给 Jev 的状态中移除。
3. 把问题、结算规则、选项和指定背景传给 Jev。
4. 记录 Jev 的选择、概率、置信度和延迟。
5. 用实际结果计算准确率和 Brier score。
6. 使用事件前的 CLOB 价格作为市场基线，而不是使用已经结算的终局价格。

代码拥有实验流程；Jev 只负责输出结构化判断。

## 目录

```text
src/
  polymarket-jev.ts       单市场历史实验与分析
  batch-historical-jev.ts 批量历史实验、重复测试、背景消融
data/                     已保存的 JSONL 结果和 summary
docs/
  experiment-log.md       实验记录
```

## 运行环境

- Node.js 20+
- pnpm
- TypeSafe API key

安装依赖并检查类型：

```powershell
pnpm install
pnpm typecheck
```

API key 只放在本地 shell 或 secret manager 中，不要写入仓库：

```powershell
$env:TYPESAFE_API_KEY = "ts_your_key_here"
```

如果本机网络需要代理，也可以在当前 PowerShell 会话中设置：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7893"
$env:HTTP_PROXY = $env:HTTPS_PROXY
$env:NODE_USE_ENV_PROXY = "1"
```

## 单市场实验

```powershell
pnpm start
```

结果会追加到 `data/jev-snapshots.jsonl`。对已经结算的市场运行分析：

```powershell
pnpm analyze
```

## 批量历史测试

运行 100 个已结算的二元体育/电竞市场：

```powershell
$env:JEV_BATCH_COUNT = "100"
$env:JEV_BATCH_CONCURRENCY = "5"
pnpm batch:historical
```

默认只运行一次 `generic` 背景。每次运行会生成一对文件：

```text
data/jev-batch-<run-id>.jsonl
data/jev-batch-<run-id>-summary.json
```

### 固定样本重复测试

重复测试只选择一次市场，并缓存市场基线，然后重复调用 Jev：

```powershell
$env:JEV_BATCH_COUNT = "100"
$env:JEV_BATCH_REPEATS = "5"
$env:JEV_BATCH_CONCURRENCY = "5"
pnpm batch:historical
```

summary 会保存每轮结果和 `repeatAggregate`，包括准确率、Brier score 和标准差。

### 背景信息消融测试

同一批市场可以在四种背景模式下运行：

```powershell
$env:JEV_BATCH_COUNT = "100"
$env:JEV_BATCH_REPEATS = "1"
$env:JEV_BATCH_BACKGROUND_MODES = "bare,generic,sports_prior,calibrated"
$env:JEV_BATCH_CONCURRENCY = "5"
pnpm batch:historical
```

模式含义：

- `bare`：不提供额外背景；
- `generic`：通用历史市场背景；
- `sports_prior`：列出体育判断维度，但不提供具体球队事实；
- `calibrated`：强调缺少证据时不要制造过度确定性。

结果位于 summary 的 `ablationSummaries` 中。这个测试隔离的是背景框架影响，不等同于加入真实赛前情报。

## 指标说明

- 准确率：Jev 选择正确结果的比例。
- Brier score：概率预测和实际结果之间的平方误差，越低越好；二元均匀猜测的基线是 `0.5`。
- probability of actual：Jev 分配给实际结果的概率。
- high-confidence wrong：置信度至少 70% 但选择错误的次数。
- market baseline：事件结束前一小时（默认）的 CLOB 价格；如果历史元数据不可靠，脚本会修正时间窗口并记录 fallback 情况。

终局价格只用于识别实际结果和评分，不会发送给 Jev。

## 当前实验观察

最近一次 100 个市场、5 次固定样本重复测试：

- Jev 平均准确率：70.4%；
- Jev 平均 Brier：0.4362；
- 市场准确率：71.43%；
- 市场 Brier：0.4234；
- 100 个问题中，68 个五次全部判断正确，28 个五次全部判断错误，4 个出现判断摇摆。

当前最值得研究的现象是：Jev 在许多单题上能优于市场，但少数稳定的高置信度错误会显著拉高总体 Brier。详细记录见 [docs/experiment-log.md](docs/experiment-log.md)。

## 安全边界

- 不要提交 `.env` 或真实 API key。
- 本项目只做历史实验和娱乐性比较，不执行交易。
- Polymarket 的市场规则、历史价格和 API 返回可能变化；结果应以保存的 JSONL 和运行时参数为准。
