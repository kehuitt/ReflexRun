import { readDOM } from './browser.js';
import { observation } from './compiler.js';
import type { Action, Host, Locator } from './types.js';

type CuaLocator = CuaRoot & {
  click(): Promise<void>;
  fill(text: string): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
  selectOption(value: string | string[]): Promise<void>;
  setChecked(value: boolean): Promise<void>;
  nth(index: number): CuaLocator;
  waitFor(options: { state: 'visible' }): Promise<void>;
};
type CuaRoot = {
  locator(selector: string): CuaLocator;
  getByRole(role: string, options: { name?: string; exact: boolean }): CuaLocator;
  getByLabel(name: string, options: { exact: boolean }): CuaLocator;
  getByPlaceholder(name: string, options: { exact: boolean }): CuaLocator;
  getByText(name: string, options: { exact: boolean }): CuaLocator;
  getByTestId(name: string): CuaLocator;
  frameLocator(selector: string): CuaRoot;
};
export type CuaBrowserPort = {
  goto(url: string): Promise<void>;
  playwright: CuaRoot & {
    evaluate<T>(fn: () => T): Promise<T>;
    waitForEvent(
      event: 'filechooser',
    ): Promise<{ setFiles(paths: string | string[]): Promise<void> }>;
  };
};

/** Uses only the existing CUA browser APIs. This layer never controls the OS itself. */
export class CuaBrowserHost implements Host {
  id = 'cua-browser';
  readonly capabilities = [
    'click',
    'fill',
    'type',
    'press',
    'select',
    'check',
    'upload',
    'navigate',
    'wait',
  ] as const;
  constructor(readonly tab: CuaBrowserPort) {}
  acceptsIntent() {
    return true;
  }
  async observe() {
    return observation(await this.tab.playwright.evaluate(readDOM));
  }
  private target(t: Locator) {
    if (t.nameIncludes !== undefined)
      throw new Error('This CUA browser port does not expose partial-name locators');
    let root: CuaRoot = this.tab.playwright;
    for (const f of t.frames ?? []) root = root.frameLocator(f);
    if (t.within) root = root.locator(t.within);
    let target = t.label
      ? root.getByLabel(t.label, { exact: true })
      : t.placeholder
        ? root.getByPlaceholder(t.placeholder, { exact: true })
        : t.role
          ? root.getByRole(t.role, { name: t.name, exact: true })
          : t.testId
            ? root.getByTestId(t.testId)
            : t.text
              ? root.getByText(t.text, { exact: true })
              : root.locator(t.css!);
    return t.index === undefined ? target : target.nth(t.index);
  }
  async act(a: Action) {
    if (a.kind === 'navigate') {
      await this.tab.goto(a.url ?? String(a.value));
      return;
    }
    if (!a.target) throw new Error('This CUA browser action needs a semantic target');
    const target = this.target(a.target);
    switch (a.kind) {
      case 'click':
        await target.click();
        break;
      case 'fill':
        await target.fill(String(a.value ?? ''));
        if (a.submit) await target.press('Enter');
        break;
      case 'type':
        await target.type(String(a.value ?? ''));
        break;
      case 'press':
        await target.press(String(a.value));
        break;
      case 'select':
        await target.selectOption(a.value as string | string[]);
        break;
      case 'check':
        await target.setChecked(Boolean(a.value));
        break;
      case 'wait':
        await target.waitFor({ state: 'visible' });
        break;
      case 'upload': {
        const pending = this.tab.playwright.waitForEvent('filechooser');
        await target.click();
        await (await pending).setFiles(a.value as string | string[]);
        break;
      }
      default:
        throw new Error(
          `The CUA browser does not expose ${a.kind}; keep that action in the original host`,
        );
    }
  }
}
