import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
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
