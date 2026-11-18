const KB = 1024;

export const kbToBytes = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.round(numeric * KB);
};

export const bytesToMiB = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "0.0 MiB";
  return `${(numeric / (1024 * 1024)).toFixed(1)} MiB`;
};

const normalizeMetric = (metric) => {
  const memory = metric?.memory ?? {};
  return {
    type: typeof metric?.type === "string" ? metric.type : "unknown",
    pid: Number.isFinite(metric?.pid) ? metric.pid : null,
    creationTime: Number.isFinite(metric?.creationTime) ? metric.creationTime : null,
    workingSetBytes: kbToBytes(memory.workingSetSize),
    peakWorkingSetBytes: kbToBytes(memory.peakWorkingSetSize),
    privateBytes: kbToBytes(memory.privateBytes),
    sharedBytes: kbToBytes(memory.sharedBytes),
  };
};

export const summarizeAppMetrics = (metrics) => {
  const normalized = Array.isArray(metrics) ? metrics.map(normalizeMetric) : [];
  const byType = new Map();
  let totalWorkingSetBytes = 0;
  let totalPrivateBytes = 0;

  for (const metric of normalized) {
    totalWorkingSetBytes += metric.workingSetBytes;
    totalPrivateBytes += metric.privateBytes;
    const current = byType.get(metric.type) ?? {
      count: 0,
      workingSetBytes: 0,
      privateBytes: 0,
      peakWorkingSetBytes: 0,
    };
    current.count += 1;
    current.workingSetBytes += metric.workingSetBytes;
    current.privateBytes += metric.privateBytes;
    current.peakWorkingSetBytes = Math.max(current.peakWorkingSetBytes, metric.peakWorkingSetBytes);
    byType.set(metric.type, current);
  }

  return {
    metrics: normalized,
    totalWorkingSetBytes,
    totalPrivateBytes,
    byType: Array.from(byType.entries())
      .map(([type, values]) => ({ type, ...values }))
      .sort((a, b) => b.workingSetBytes - a.workingSetBytes || a.type.localeCompare(b.type)),
  };
};

export const formatMemoryReport = ({ buildLabel, states }) => {
  const lines = [];
  if (buildLabel) lines.push(`Build: ${buildLabel}`);
  for (const state of states) {
    lines.push("");
    lines.push(`${state.label}:`);
    lines.push(`- route: ${state.route}`);
    lines.push(`- DOM nodes: ${state.domNodeCount}`);
    lines.push(`- JS heap used: ${bytesToMiB(state.jsHeapUsedBytes)}`);
    lines.push(`- Electron working set: ${bytesToMiB(state.processes.totalWorkingSetBytes)}`);
    lines.push(`- Electron private bytes: ${bytesToMiB(state.processes.totalPrivateBytes)}`);
    lines.push("- Process types:");
    for (const processType of state.processes.byType) {
      lines.push(
        `  - ${processType.type}: ${processType.count} process(es), working set ${bytesToMiB(processType.workingSetBytes)}, private ${bytesToMiB(processType.privateBytes)}`
      );
    }
  }
  return `${lines.join("\n").trim()}\n`;
};
