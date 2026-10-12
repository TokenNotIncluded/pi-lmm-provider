import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import lmmExtension from '../src/index.ts';

test('native currency command queries, persists, reloads and rejects without requests or assistant turns', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-currency-command-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const originalFetch = globalThis.fetch;
  let requests = 0;
  process.env.PI_CODING_AGENT_DIR = directory;
  globalThis.fetch = async () => { requests++; throw new Error('No network permitted'); };
  try {
    const messages: string[] = [];
    function load() {
      const commands = new Map<string, Parameters<ExtensionAPI['registerCommand']>[1]>();
      lmmExtension({
        on: () => () => {}, registerProvider: () => {},
        registerCommand: (name, command) => commands.set(name, command),
        sendMessage: (message, options) => {
          assert.equal(options?.triggerTurn, false);
          assert.equal(message.customType, 'lmm-currency');
          messages.push(String(message.content));
        },
      } satisfies Pick<ExtensionAPI, 'on' | 'registerProvider' | 'registerCommand' | 'sendMessage'> as unknown as ExtensionAPI);
      return commands.get('lmm-currency')!;
    }
    const ctx = {} as ExtensionCommandContext;
    const command = load();
    assert.ok(command);
    await command.handler('', ctx);
    assert.match(messages.at(-1)!, /display: CREDITS/);
    assert.deepEqual(readdirSync(directory), [], 'query does not create global settings');
    await command.handler('cny', ctx);
    assert.match(messages.at(-1)!, /not changed/);
    await command.handler('cny 6.5', ctx);
    assert.match(messages.at(-1)!, /display: CNY.*Manual estimate/);
    const saved = readFileSync(join(directory, 'lmm-currency.json'), 'utf8');
    await load().handler('', ctx);
    assert.match(messages.at(-1)!, /display: CNY.*1 USD = 6.5 CNY/);
    await command.handler('cny -1', ctx);
    assert.equal(readFileSync(join(directory, 'lmm-currency.json'), 'utf8'), saved);
    await command.handler('usd', ctx);
    await load().handler('', ctx);
    assert.match(messages.at(-1)!, /display: USD/);
    assert.equal(requests, 0);
    assert.deepEqual(readdirSync(directory), ['lmm-currency.json'], 'no auth or Pi settings file created');
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
