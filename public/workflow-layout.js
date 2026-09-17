(function exposeWorkflowLayout(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WorkflowLayout = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  const DEFAULTS = Object.freeze({ cols:6, visibleRows:5, xGap:155, yGap:125, left:76, top:58 });

  function createWorkflowLayout(count, options = {}) {
    const config = { ...DEFAULTS, ...options };
    const rows = Math.max(1, Math.ceil(Math.max(0, count) / config.cols));
    const viewportHeight = config.top * 2 + (config.visibleRows - 1) * config.yGap;
    const contentHeight = config.top * 2 + (rows - 1) * config.yGap;
    const width = Math.max(930, config.left * 2 + (config.cols - 1) * config.xGap);
    const positions = Array.from({ length:count }, (_, index) => {
      const row = Math.floor(index / config.cols);
      const offset = index % config.cols;
      const reverse = row % 2 === 1;
      return { x:config.left + (reverse ? config.cols - 1 - offset : offset) * config.xGap, y:config.top + row * config.yGap, row };
    });
    return { ...config, rows, width, viewportHeight, height:Math.max(viewportHeight, contentHeight), positions };
  }

  function compactWorkflowEvents(events) {
    const compacted = [];
    events.forEach((event, index) => {
      const numbered = { ...event, windowStep:index + 1 };
      const previous = compacted.at(-1);
      const preservesEveryOccurrence = ["tool", "error", "alert"].includes(numbered.category);
      const sameBehavior = previous
        && !preservesEveryOccurrence
        && previous.phase === numbered.phase
        && previous.category === numbered.category
        && (previous.threadId || null) === (numbered.threadId || null)
        && (previous.turnId || null) === (numbered.turnId || null);
      if (!sameBehavior) compacted.push(numbered);
    });
    return compacted;
  }

  return { DEFAULTS, createWorkflowLayout, compactWorkflowEvents };
});
