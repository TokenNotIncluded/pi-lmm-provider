import { createBashTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PROVIDER_ID } from './protocol.ts';

/** Reassert the actual Pi tool environment for models trained on Codex tools. */
export function registerToolGuidance(pi: ExtensionAPI): void {
  pi.on('before_agent_start', (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return;
    const active = new Set(pi.getActiveTools());
    const guidance = [
      'This session runs in Pi. Only call tools declared in the current tool list, using their supplied schemas. Tool names are not shell commands.',
    ];
    if (active.has('write')) guidance.push('Use the native write tool to create files or perform complete rewrites.');
    if (active.has('edit')) guidance.push('Use the native edit tool for precise changes to existing files.');
    if (!active.has('apply_patch')) guidance.push('There is no registered apply_patch tool. Do not assume the Codex apply_patch command exists inside bash; use the available Pi file tools instead.');
    guidance.push('If a file operation fails, recover using an available tool and verify that the target file exists before opening, previewing, or executing it. Do not claim the artifact was created after a failed write.');
    return { systemPrompt: `${event.systemPrompt}\n\n${guidance.join('\n')}` };
  });
}

/** Narrow checks for direct commands in Pi's local built-in bash environment. */
export function registerToolGuard(pi: ExtensionAPI): void {
  pi.on('tool_call', async (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID || event.toolName !== 'bash') return;
    // Custom/remote bash tools can use another filesystem and executable search path.
    const bash = pi.getAllTools().find((tool) => tool.name === 'bash');
    if (bash?.sourceInfo?.path !== 'builtin:bash') return;
    // Earlier supported Pi hosts expose no effective shell settings API.
    // Keep guidance there rather than probing a potentially different shell.
    const getSettings: unknown = Reflect.get(pi, 'getSettings');
    if (typeof getSettings !== 'function') return;
    const settings = getSettings.call(pi) as { shellPath?: string; shellCommandPrefix?: string };
    const command = event.input.command;
    if (typeof command !== 'string') return;
    if (/^\s*apply_patch(?:\s|$)/.test(command)) {
      const probe = createBashTool(ctx.cwd, {
        shellPath: settings.shellPath, commandPrefix: settings.shellCommandPrefix,
        exposeSessionEnvironment: false,
      });
      try {
        const result = await probe.execute('lmm-apply-patch-probe', { command: 'command -v apply_patch >/dev/null 2>&1', timeout: 5 });
        if (Reflect.get(result, 'isError') === true) throw new Error('apply_patch probe failed');
      } catch {
        const files = pi.getActiveTools().filter((name) => name === 'write' || name === 'edit');
        return { block: true, reason: `apply_patch is unavailable in the current Pi bash environment. ${files.length ? `Use the active native ${files.join('/')} tools with their supplied schemas.` : 'Native write/edit tools are not active; do not assume an undeclared tool is available.'} The command was blocked before execution; no file was created by it.` };
      }
    }
    // Check only a standalone literal file preview, never interpret arbitrary shell code.
    // A command prefix can change cwd or filesystem visibility; do not guess it.
    if (settings.shellCommandPrefix) return;
    const preview = /^\s*xdg-open\s+(?:'([^']+)'|"([^"$`]+)"|([^\s;&|<>$`]+))\s*$/.exec(command);
    const path = preview?.[1] ?? preview?.[2] ?? preview?.[3];
    if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path)) return;
    try { await stat(resolve(ctx.cwd, path)); } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return { block: true, reason: 'The preview file does not exist. Create or recover the file with an active file tool and verify the write succeeded before opening it.' };
      }
    }
  });
}
