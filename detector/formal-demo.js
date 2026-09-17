const FORMAL_DEMO_THREAD_ID = "awdl-test";

function demoEvent(phase, category, title, detail, raw) {
  return { phase, category, title, detail, raw, source:"awdl-demo", runId:"formal-demo", threadId:FORMAL_DEMO_THREAD_ID };
}

function buildFormalDemoTrace(scenario) {
  if (!["livelock", "retry-loop"].includes(scenario)) throw new Error("未知的形式化演示场景");
  const command = (name) => demoEvent("TOOL_CALLING", "tool", name, `调用动作：${name}`, { type:"item.started", item:{ type:"command_execution", command:name, status:"in_progress" } });
  const plan = (text) => demoEvent("RESPONDING", "message", "重新规划", text);
  const events = [
    demoEvent("STARTING", "lifecycle", "形式化轨迹开始", scenario === "livelock" ? "注入周期活锁验证轨迹" : "注入重复动作死循环验证轨迹"),
    demoEvent("STARTED", "lifecycle", "Agent 已启动", scenario === "livelock" ? "开始自动规划" : "开始执行动作"),
  ];
  if (scenario === "livelock") {
    for (let cycle = 0; cycle < 6; cycle += 1) events.push(command("search-same-target"), plan("未取得新信息，返回同一规划阶段"));
  } else {
    for (let retry = 0; retry < 12; retry += 1) events.push(command("retry-identical-action"));
  }
  return events;
}

module.exports = { FORMAL_DEMO_THREAD_ID, demoEvent, buildFormalDemoTrace };
