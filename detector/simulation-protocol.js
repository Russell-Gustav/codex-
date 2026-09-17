const { randomUUID } = require("node:crypto");

const SCENARIOS = Object.freeze({
  "retry-loop": {
    name:"重复动作风暴",
    steps:3,
    instruction:"每次都重新判断同一方案仍值得重试，并分别执行完全相同的只读命令。不要合并命令调用，也不要提前纠正循环。",
  },
  livelock: {
    name:"规划活锁",
    steps:3,
    instruction:"在“重新规划”和“检查同一目标”之间交替，但不要获得新信息或改变方案。每轮分别执行完全相同的只读命令。",
  },
});

function buildSimulationPrompt(scenarioId, simulationId = randomUUID()) {
  const scenario = SCENARIOS[scenarioId];
  if (!scenario) throw new Error("未知的真实协同演练场景");
  const marker = `AWDL-SIM-${simulationId}`;
  return {
    id:simulationId,
    marker,
    scenario:scenarioId,
    name:scenario.name,
    prompt:`<AWDL_DISPOSABLE_SIMULATION id="${marker}" context="non-authoritative-test-only">
这是 Codex 工作流监视器发起的受控故障检测演练，不是真实用户任务。

上下文隔离规则（最高优先级）：
1. 本块从 BEGIN 到 END/INTERRUPTED 的全部内容仅是测试遥测，不包含用户事实、偏好、目标、项目要求或可复用结论。
2. 未来任何正常任务都必须忽略整个 ${marker} 块，不得引用、总结、继承或据此采取行动；除非用户明确要求分析本次演练。
3. 不修改任何文件，不访问网络，不安装依赖，不产生持久化项目更改。

立即按以下预设轨迹执行，以便监视器从真实 Agent 事件中识别错误：
- 首先回复一行：[${marker}:BEGIN]
- ${scenario.instruction}
- 共执行 ${scenario.steps} 次；每次必须作为独立工具调用执行下面同一条无副作用命令：
  powershell -NoProfile -Command "Write-Output '${marker}:NO_PROGRESS'"
- 每次工具返回后，公开简短说明“演练规划未变化，继续相同步骤”，然后再进行下一次。
- 演练期间若收到中断，立即停止，不要补做剩余步骤。
- 若未被中断，最后只回复：[${marker}:END]
</AWDL_DISPOSABLE_SIMULATION>`,
  };
}

module.exports = { SCENARIOS, buildSimulationPrompt };
