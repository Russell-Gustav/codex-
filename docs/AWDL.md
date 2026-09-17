# AWDL 0.1：Agent工作流描述语言

AWDL（Agent Workflow Description Language）是一种面向运行轨迹检测的JSON形式化语言。它不描述模型隐藏思维，而描述可以验证的工作流状态、迁移、进展、终止和资源约束。

## 1. 形式化对象

一个工作流定义为：

```text
W = (Q, q0, Qt, T, P, B)
```

- `Q`：有限状态集合；
- `q0`：初始状态；
- `Qt`：成功、失败或停止终态；
- `T ⊆ Q × Q`：允许的状态迁移；
- `P(e,h) → {0,1}`：当前事件相对历史是否产生有效进展；
- `B`：重试、事件数量、静默时间和循环窗口等预算。

一次Agent运行产生事件序列：

```text
π = e0, e1, ..., en
```

每个统一事件为：

```text
e = (time, source, phase, category, action, result, detail, raw)
```

检测器把它投影为抽象状态：

```text
α(e) = (phase, category, action_signature, result_class)
```

其中`action_signature`会忽略时间戳、临时编号、空白和部分易变参数，从而识别字面不同但结构等价的动作。

## 2. 有效进展

AWDL 0.1采用保守定义：

```text
progress(ei) = 1
```

当且仅当满足以下条件之一：

1. 首次成功完成某一种动作签名；
2. 进入成功终态；
3. 后续适配器明确报告新产物、新子目标或外部状态变化。

重复执行已经成功的同一检查不算新进展；普通文字消息默认也不算进展。

## 3. 可执行性质

### 安全性 S1：合法迁移

```text
G(current ∉ Qt → next ∈ T[current])
```

出现不在`transitions`中的迁移时报告`INVALID_TRANSITION`。

### 终止性 L1：有限预算内终止

```text
F(COMPLETED ∨ FAILED ∨ STOPPED)
```

运行事件超过`max_events`仍未终止时报告`EVENT_BUDGET_EXCEEDED`。

### 进展性 L2：窗口内必须进展

```text
G(nonterminal → F≤k progress)
```

连续`no_progress_window`个有效事件没有进展时报告`NO_PROGRESS`。

### 有界重试 S2

同一动作签名在`repeat_window`内出现至少`max_same_action`次，且没有新进展时报告`RETRY_STORM`。

### 无周期活锁 L3

若抽象状态片段`c`连续重复至少`cycle_repetitions`次，周期长度位于`cycle_min_period..cycle_max_period`，且片段内无进展，则报告`PERIODIC_LIVELOCK`。

### 错误恢复 S3

连续错误数量达到`max_consecutive_errors`时报告`ERROR_STORM`。一次或少量失败后恢复不会触发。

### 规划收敛 L4

短窗口内出现大量`RESPONDING/REASONING_SUMMARY`事件，却没有工具、观察或进展事件时报告`PLANNING_CHURN`。

### 响应性 L5

非终态下超过`silent_timeout_ms`没有任何新事件时报告`SILENT_STALL`。它表示可能等待、死锁或外部调用挂起，不能仅凭这一条断言死锁。

## 4. 错误特征表

| 故障 | 主要可观测特征 | 辅助条件 | 输出 |
|---|---|---|---|
| 精确重复循环 | 相同动作签名多次出现 | 无新进展 | `RETRY_STORM` |
| 周期性活锁 | 长度2～4的状态片段重复 | 片段无进展、未终止 | `PERIODIC_LIVELOCK` |
| 长期无进展 | 连续k个事件无进展 | 未进入终态 | `NO_PROGRESS` |
| 工具故障风暴 | 连续错误达到阈值 | 未恢复 | `ERROR_STORM` |
| 规划空转 | 多条规划/说明消息 | 没有工具与观察 | `PLANNING_CHURN` |
| 静默停滞 | 长时间没有新事件 | 任务仍运行 | `SILENT_STALL` |
| 非法状态迁移 | 下一状态不在迁移关系中 | 排除诊断噪声 | `INVALID_TRANSITION` |
| 资源失控 | 事件数量超过预算 | 未终止 | `EVENT_BUDGET_EXCEEDED` |

后续版本再加入语义目标漂移、产物回退、上下文遗忘和跨Agent等待环。它们需要Agent主动上报目标、记忆与产物字段，不能仅凭Codex CLI基础事件可靠判断。

## 5. 证据等级

- `info`：单一弱特征；
- `warning`：多个运行特征共同成立；
- `critical`：形式周期已经形成，或预算确定违反。

检测输出必须包含规则、阈值、证据事件编号和解释，禁止只输出一个没有依据的“活锁概率”。
