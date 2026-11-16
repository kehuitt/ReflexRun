import { elementFor } from './compiler.js';
import { fromAccessibility } from './callback.js';
import type { Action, Host } from './types.js';

/** Structural interface: pass an existing cua.getApp() handle. No CUA dependency or app template. */
export type CuaAppPort = {
  getAXState(options?: { emit?: boolean; disableDiffing?: boolean }): Promise<string>;
  click(target: number | [number, number]): Promise<void>;
  setValue(index: number, value: string): Promise<void>;
  typeText(value: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  scroll(
    target: number | [number, number],
    direction: 'up' | 'down' | 'left' | 'right',
    pages?: number,
  ): Promise<void>;
};
export class CuaAppHost implements Host {
  id = 'cua-native';
  readonly capabilities = ['click', 'fill', 'type', 'press', 'check', 'scroll', 'wait'] as const;
  constructor(
    readonly app: CuaAppPort,
    readonly scope: string,
  ) {
    if (!scope?.trim())
      throw new Error('Native Computer Use requires an explicit app or page scope');
  }
  async observe() {
    return fromAccessibility(
      await this.app.getAXState({ emit: false, disableDiffing: true }),
      this.scope,
    );
  }
  async act(action: Action) {
    if (action.submit)
      throw new Error('This native host does not expose a combined fill and submit action');
    const state = await this.observe();
    const element = action.target ? elementFor(action.target, state) : undefined;
    if (action.target && !element)
      throw new Error('Native accessibility target changed or is ambiguous');
    const index = element ? Number(element.ref) : undefined;
    switch (action.kind) {
      case 'click':
        if (index === undefined) throw new Error('Native click needs a semantic target');
        await this.app.click(index);
        break;
      case 'fill':
        if (index === undefined) throw new Error('Native fill needs a semantic target');
        await this.app.setValue(index, String(action.value ?? ''));
        break;
      case 'type':
        if (index !== undefined) await this.app.click(index);
        await this.app.typeText(String(action.value ?? ''));
        break;
      case 'press':
        if (index !== undefined) await this.app.click(index);
        await this.app.pressKey(String(action.value));
        break;
      case 'check':
        if (index === undefined) throw new Error('Native check needs a target');
        if (
          Boolean(action.value) !==
          ['1', 'true', 'yes'].includes(element!.value?.toLowerCase() ?? '')
        )
          await this.app.click(index);
        break;
      case 'scroll':
        if (index === undefined) throw new Error('Native scroll needs a semantic target');
        {
          const v = action.value as { direction?: string; pages?: number } | undefined;
          await this.app.scroll(index, (v?.direction ?? 'down') as 'down', v?.pages ?? 1);
          break;
        }
      case 'wait':
        if (action.target && !element) throw new Error('Native target not ready');
        break;
      default:
        throw new Error(
          `Unsupported native bridge action ${action.kind}; the original host can expose it through CallbackHost`,
        );
    }
  }
}
