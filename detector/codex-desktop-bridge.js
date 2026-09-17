const { spawn } = require("node:child_process");

function encodedPowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

const BRIDGE_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AwDlWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
$requestText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CODEX_DESKTOP_REQUEST))
$request = $requestText | ConvertFrom-Json
$desktopRoot = [Windows.Automation.AutomationElement]::RootElement
$windowCondition = New-Object Windows.Automation.AndCondition(
  (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Window)),
  (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, 'ChatGPT'))
)
$root = $desktopRoot.FindFirst([Windows.Automation.TreeScope]::Children, $windowCondition)
if (-not $root) { throw '找不到正在运行的 Codex Desktop 主窗口' }
$process = Get-Process -Id $root.Current.ProcessId -ErrorAction SilentlyContinue
$windowHandle = [IntPtr]$root.Current.NativeWindowHandle
$descendants = [Windows.Automation.TreeScope]::Descendants
$documents = $root.FindAll($descendants, [Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::Document -and $_.Current.Name }
$document = $documents | Sort-Object { $_.Current.Name.Length } -Descending | Select-Object -First 1
if (-not $document) { throw 'Codex Desktop 未暴露当前对话文档' }
$title = $document.Current.Name.Trim()
$elements = $root.FindAll($descendants, [Windows.Automation.Condition]::TrueCondition)
$busy = [bool]($elements | Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $_.Current.Name -match '^(停止|Stop)$' } | Select-Object -First 1)
$editor = $elements | Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::Edit -and $_.Current.IsEnabled } | Select-Object -Last 1
$result = [ordered]@{ title=$title; processId=$root.Current.ProcessId; windowHandle=$windowHandle.ToInt64(); busy=$busy; inputAvailable=[bool]$editor; sent=$false }
if ($request.action -eq 'stop') {
  if ($title -ne [string]$request.expectedTitle) { throw "当前对话已变化，拒绝误操作：$title" }
  $stopButton = $elements | Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $_.Current.Name -match '^(停止|Stop)$' } | Select-Object -First 1
  if (-not $stopButton) { throw '当前 Codex 对话没有可用的停止按钮' }
  $invoke = $stopButton.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
  $invoke.Invoke()
  $result.sent = $true
}
if ($request.action -eq 'send') {
  if ($title -ne [string]$request.expectedTitle) { throw "当前对话已变化，拒绝误投：$title" }
  if ($busy) { throw '当前 Codex 对话仍在处理中，请等待本轮完成后再启动演练' }
  if (-not $editor) { throw '找不到当前 Codex 对话的输入框' }
  [AwDlWindow]::SetForegroundWindow($windowHandle) | Out-Null
  $editor.SetFocus()
  Start-Sleep -Milliseconds 120
  $set = $false
  try {
    $pattern = $editor.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    if (-not $pattern.Current.IsReadOnly) { $pattern.SetValue([string]$request.text); $set = $true }
  } catch {}
  if (-not $set) {
    $oldClipboard = $null
    try { if ([Windows.Forms.Clipboard]::ContainsText()) { $oldClipboard = [Windows.Forms.Clipboard]::GetText() } } catch {}
    [Windows.Forms.Clipboard]::SetText([string]$request.text)
    [Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 120
    if ($null -ne $oldClipboard) { [Windows.Forms.Clipboard]::SetText($oldClipboard) } else { [Windows.Forms.Clipboard]::Clear() }
  }
  [Windows.Forms.SendKeys]::SendWait('{ENTER}')
  $result.sent = $true
}
$result | ConvertTo-Json -Compress`;

function desktopRequest(request, options = {}) {
  if (process.platform !== "win32") return Promise.reject(new Error("Codex Desktop 前台通信目前仅支持 Windows"));
  const timeoutMs = options.timeoutMs || 10_000;
  const payload = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", encodedPowerShell(BRIDGE_SCRIPT)], {
      windowsHide:true,
      env:{ ...process.env, CODEX_DESKTOP_REQUEST:payload },
      stdio:["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", settled = false;
    const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); callback(value); };
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(reject, new Error("读取 Codex Desktop 当前窗口超时")); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) return finish(reject, new Error(stderr.trim() || `Codex Desktop 桥接退出码 ${code}`));
      try { finish(resolve, JSON.parse(stdout.trim())); }
      catch { finish(reject, new Error(`无法解析 Codex Desktop 窗口状态：${stdout.trim() || stderr.trim()}`)); }
    });
  });
}

function inspectCodexDesktop() { return desktopRequest({ action:"inspect" }); }
function sendToCodexDesktop({ expectedTitle, text }) { return desktopRequest({ action:"send", expectedTitle, text }); }
function stopCodexDesktop({ expectedTitle }) { return desktopRequest({ action:"stop", expectedTitle }); }

module.exports = { inspectCodexDesktop, sendToCodexDesktop, stopCodexDesktop, desktopRequest, BRIDGE_SCRIPT };
