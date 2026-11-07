const zh = navigator.language.toLowerCase().startsWith('zh');
const started = performance.now();
const elapsed = document.getElementById('elapsed');
const hint = document.getElementById('hint');
if (zh) {
  document.documentElement.lang = 'zh-CN';
  document.getElementById('stage').textContent = '正在打开工作空间…';
  document.getElementById('local').textContent = '本地运行 · 由你掌控';
  hint.textContent = '正在准备你的工作空间';
}
setInterval(() => {
  const seconds = Math.floor((performance.now() - started) / 1000);
  elapsed.textContent = zh ? `已等待 ${seconds} 秒` : `${seconds}s elapsed`;
  if (seconds >= 20)
    hint.textContent = zh
      ? '启动比平时稍久，仍在等待后台服务响应。无需重复打开。'
      : 'Taking longer than usual. Waiting for the local service; no need to launch again.';
}, 1000);
window.setBootStage = (phase, english, chinese) => {
  document.getElementById('stage').textContent = zh ? chinese : english;
  document.getElementById('phase').textContent = `0${phase} / 03`;
};
