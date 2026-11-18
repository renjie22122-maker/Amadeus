import { Shield } from 'lucide-react';
import { ControlPopover } from './ControlPopover';
import type { Conversation, Settings } from '../../shared/types';
import { executionSettings } from '../../shared/execution';
export function SecurityControl({
  conversation,
  settings,
  disabled,
  zh,
  onChange,
}: {
  conversation: Conversation;
  settings: Settings;
  disabled: boolean;
  zh: boolean;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const effective = executionSettings(settings, conversation),
    readonly = conversation.permission === 'read-only';
  const mode =
    effective.commandBackend === 'native-windows'
      ? 'native-' + (effective.nativeNetwork || 'deny')
      : effective.commandBackend;
  const names: Record<string, string> = {
    'read-only': zh ? '只读' : 'Read only',
    ask: zh ? '执行前询问' : 'Ask before execution',
    auto: zh ? '帮我审批' : 'Approve for me',
    trusted: zh ? '无需逐次审批' : 'No per-command approval',
  };
  const choices = [
    ['approval-host', zh ? '宿主执行' : 'Host execution'],
    ['native-host', zh ? 'AppContainer · 文件隔离' : 'AppContainer · Files'],
    ['native-deny', zh ? 'AppContainer · 严格离线' : 'AppContainer · Offline'],
    ['mxc', zh ? 'Windows MXC · 临时工作区' : 'Windows MXC · Scratch workspace'],
    ['docker', zh ? 'Docker · 离线容器' : 'Docker · Offline'],
  ];
  return (
    <ControlPopover
      label={(zh ? '权限与安全 · ' : 'Access · ') + names[conversation.permission]}
      icon={<Shield size={15} />}
      disabled={disabled}
    >
      <div className="security-control">
        <strong>{zh ? '当前对话的权限与安全' : 'Access and security for this chat'}</strong>
        <label>
          {zh ? '审批方式' : 'Approval'}
          <select
            value={conversation.permission}
            onChange={(e) => {
              const permission = e.target.value;
              if (
                permission === 'trusted' &&
                !confirm(
                  zh
                    ? '取消逐次命令审批？所选隔离仍生效；宿主模式下命令拥有你的账号权限。'
                    : 'Disable per-command approval? Isolation remains enforced; host commands have your account permissions.',
                )
              )
                return;
              onChange({ permission });
            }}
          >
            {Object.entries(names).map(([v, n]) => (
              <option key={v} value={v}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          {zh ? '执行环境' : 'Execution environment'}
          <select
            disabled={readonly}
            value={mode}
            onChange={(e) => {
              const v = e.target.value;
              if (
                v === 'approval-host' &&
                !confirm(
                  zh
                    ? '改为宿主执行？命令将不受 OS 文件隔离，使用你的账号权限。'
                    : 'Use host execution without OS file isolation, with your account permissions?',
                )
              )
                return;
              onChange({
                execution: {
                  backend: v.startsWith('native-') ? 'native-windows' : v,
                  network: v === 'native-host' || v === 'approval-host' ? 'host' : 'deny',
                },
              });
            }}
          >
            {choices.map(([v, n]) => (
              <option key={v} value={v}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">
          {readonly
            ? zh
              ? '只读：不能修改文件或执行命令。恢复执行权限后使用下方环境。'
              : 'Read only: file writes and command execution are disabled. The selected environment applies when execution is enabled.'
            : mode === 'approval-host'
              ? zh
                ? '无 OS 文件隔离。批准后的命令使用宿主账号权限。'
                : 'No OS file isolation. Approved commands run with host account permissions.'
              : mode === 'native-host'
                ? zh
                  ? '文件访问由 AppContainer 限制；允许网络。审批不会解除隔离。'
                  : 'AppContainer restricts file access; networking is allowed. Approval does not remove isolation.'
                : mode === 'docker'
                  ? zh
                    ? '需 Docker 和本地镜像；离线运行，仅挂载执行目录。不可用时拒绝执行。'
                    : 'Requires Docker and a local image; runs offline with the execution directory mounted. Unavailable backends reject execution.'
                  : zh
                    ? '文件隔离并预检断网。预检失败会拒绝执行，不退回宿主。'
                    : 'File isolation with offline preflight. Failed checks reject execution; no host fallback.'}
        </p>
        {conversation.permission === 'auto' && (
          <p className="muted">
            {zh
              ? '独立模型检查操作；危险、不确定或审查失败时询问你，不保证识别全部风险。'
              : 'A separate model reviews actions; risky, uncertain or failed reviews ask you. Risk detection is not guaranteed.'}
          </p>
        )}
        {!conversation.projectId && (
          <p className="muted">
            {zh
              ? '普通对话仍不能执行项目命令；先绑定项目。'
              : 'Project commands also require a linked project.'}
          </p>
        )}
        <small>
          {zh
            ? '仅影响本对话；运行中不可修改。解释器与镜像在设置中配置。'
            : 'Applies to this chat only; locked while running. Configure interpreters and images in Settings.'}
        </small>
        {conversation.execution && (
          <button
            onClick={() => {
              if (
                confirm(
                  zh
                    ? '使用全局默认环境？默认设置可能具有更宽的文件或网络权限。'
                    : 'Use the global default? It may allow wider file or network access.',
                )
              )
                onChange({ execution: null });
            }}
          >
            {zh ? '恢复全局默认环境' : 'Use global default environment'}
          </button>
        )}
      </div>
    </ControlPopover>
  );
}
