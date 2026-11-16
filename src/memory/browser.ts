import type { FrameLocator, Locator as PWLocator, Page } from 'playwright';
import type { Action, FactSource, Host, Locator, Observation } from './types.js';
import { observation, validPartialName } from './compiler.js';

/** Pure DOM reader, also usable through a Computer Use host's read-only evaluate tool. */
export function readDOM(): Omit<Observation, 'stateKey' | 'layoutKey'> {
  const result: Omit<Observation, 'stateKey' | 'layoutKey'> = {
    surface: 'web',
    scope: location.origin,
    url: location.href,
    title: document.title,
    text: document.body?.innerText.slice(0, 60_000) ?? '',
    elements: [],
    collections: [],
  };
  const h = {
    visible(e: Element) {
      return e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    },
    css(e: Element) {
      if (e.id) return '#' + CSS.escape(e.id);
      const name = e.getAttribute('name');
      if (name) return `${e.tagName.toLowerCase()}[name=${JSON.stringify(name)}]`;
      const parts: string[] = [];
      let node: Element | null = e;
      while (node && node.tagName !== 'BODY') {
        const parent: Element | null = node.parentElement;
        const n = parent
          ? [...parent.children].filter((x) => x.tagName === node!.tagName).indexOf(node) + 1
          : 1;
        parts.unshift(node.tagName.toLowerCase() + `:nth-of-type(${n})`);
        node = parent;
      }
      return 'body>' + parts.join('>');
    },
    read(doc: Document, frames: string[]) {
      const counters = new Map<string, number>();
      const nodes = [
        ...doc.querySelectorAll(
          'button,a,input,textarea,select,[contenteditable="true"],[role="button"],[role="checkbox"],[role="textbox"],[role="combobox"]',
        ),
      ]
        .filter((e) => h.visible(e))
        .slice(0, 500);
      const groups = new Map<Element, string[]>();
      for (const el of nodes) {
        const input = el as HTMLInputElement;
        const type = el.getAttribute('type') ?? '';
        let role =
          el.getAttribute('role') ||
          (
            {
              BUTTON: 'button',
              A: 'link',
              TEXTAREA: 'textbox',
              SELECT: 'combobox',
              INPUT: ['checkbox', 'radio'].includes(type)
                ? type
                : ['submit', 'button'].includes(type)
                  ? 'button'
                  : type === 'range'
                    ? 'slider'
                    : 'textbox',
            } as Record<string, string>
          )[el.tagName] ||
          'textbox';
        const labels =
          'labels' in input
            ? [...(input.labels ?? [])]
                .map((l) => l.textContent?.trim())
                .filter(Boolean)
                .join(' ')
            : '';
        const labelledBy = (el.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .map((id) => doc.getElementById(id)?.textContent?.trim())
          .filter(Boolean)
          .join(' ');
        const label = el.getAttribute('aria-label') || labelledBy || labels;
        const name =
          label ||
          (role === 'button' || role === 'link'
            ? (el as HTMLElement).innerText?.trim() || input.value
            : '') ||
          el.getAttribute('placeholder') ||
          el.getAttribute('title') ||
          '';
        const group = el.closest('li,article,tr,[role="listitem"]');
        const frame = frames.length ? { frames } : {};
        let locator: Locator = label
          ? { label, ...frame }
          : name && role
            ? { role, name, ...frame }
            : el.getAttribute('data-testid')
              ? { testId: el.getAttribute('data-testid')!, ...frame }
              : { css: h.css(el), ...frame };
        if (group) {
          const attribute = ['data-id', 'data-key', 'data-item-id'].find((a) =>
            group.hasAttribute(a),
          );
          const link = group.querySelector<HTMLAnchorElement>('a[href]');
          const within = attribute
            ? `${group.tagName.toLowerCase()}[${attribute}=${JSON.stringify(group.getAttribute(attribute))}]`
            : link
              ? `${group.tagName.toLowerCase()}:has(a[href=${JSON.stringify(link.getAttribute('href'))}])`
              : undefined;
          if (within && doc.querySelectorAll(within).length === 1) locator = { ...locator, within };
        }
        const signature = JSON.stringify(locator),
          count = counters.get(signature) ?? 0;
        counters.set(signature, count + 1);
        if (count) locator = { ...locator, index: count };
        const ref = `e${result.elements.length + 1}`;
        const box = el.getBoundingClientRect();
        result.elements.push({
          ref,
          role,
          name,
          locator,
          type,
          sensitive: ['password', 'file'].includes(type),
          ...(role === 'checkbox' || role === 'radio'
            ? { value: String(input.checked) }
            : 'value' in el
              ? { value: ['password', 'file'].includes(type) ? '[redacted]' : String(input.value) }
              : {}),
          disabled: input.disabled || el.getAttribute('aria-disabled') === 'true',
          required: input.required || el.getAttribute('aria-required') === 'true',
          invalid: input.validity?.valid === false,
          state: {
            focused: doc.activeElement === el,
            ...Object.fromEntries(
              [
                'aria-pressed',
                'aria-selected',
                'aria-expanded',
                'aria-checked',
                'data-state',
                'class',
              ]
                .filter((k) => el.hasAttribute(k))
                .map((k) => [k, el.getAttribute(k)!]),
            ),
          },
          alternatives: [{ css: h.css(el), ...frame }],
          ...(el.tagName === 'SELECT'
            ? {
                options: [...(el as HTMLSelectElement).options].map((o) => ({
                  label: o.label,
                  value: o.value,
                })),
              }
            : {}),
          ...(group ? { group: h.css(group) } : {}),
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
        });
        if (group) {
          const refs = groups.get(group) ?? [];
          refs.push(ref);
          groups.set(group, refs);
        }
      }
      // Disambiguation is explicit for every repeated semantic locator, including index 0.
      for (const e of result.elements) {
        const base = { ...e.locator };
        delete base.index;
        if ((counters.get(JSON.stringify(base)) ?? 0) > 1 && e.locator.index === undefined)
          e.locator.index = 0;
      }
      const parents = new Map<Element, Element[]>();
      for (const group of groups.keys()) {
        if (!group.parentElement) continue;
        const xs = parents.get(group.parentElement) ?? [];
        xs.push(group);
        parents.set(group.parentElement, xs);
      }
      for (const [parent, rows] of parents)
        if (rows.length > 1) {
          result.collections!.push({
            ref: h.css(parent),
            items: rows.map((row) => {
              const link = row.querySelector<HTMLAnchorElement>('a[href]');
              const title =
                row.querySelector('h1,h2,h3,h4,h5,h6,a,strong')?.textContent?.trim() ??
                row.textContent?.trim().split('\n')[0] ??
                '';
              const href = link?.href;
              return {
                key: href || title,
                title,
                text: (row as HTMLElement).innerText,
                ...(href ? { href } : {}),
                actions: groups.get(row)!,
              };
            }),
          });
        }
      for (const frame of doc.querySelectorAll<HTMLIFrameElement>('iframe')) {
        try {
          if (frame.contentDocument?.body && h.visible(frame))
            h.read(frame.contentDocument, [...frames, h.css(frame)]);
        } catch {
          /* Cross-origin frames need a host that can expose their UI separately. */
        }
      }
    },
  };
  h.read(document, []);
  return result;
}

export function browserLocator(page: Page, target: Locator): PWLocator {
  if (target.nameIncludes !== undefined && !validPartialName(target))
    throw new Error('Invalid partial-name locator');
  let root: Page | FrameLocator | PWLocator = page;
  for (const frame of target.frames ?? []) root = root.frameLocator(frame);
  if (target.within) root = root.locator(target.within);
  let locator: PWLocator;
  if (target.nameIncludes !== undefined)
    locator = root.getByRole(target.role as Parameters<Page['getByRole']>[0], {
      name: new RegExp(target.nameIncludes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    });
  else if (target.label) locator = root.getByLabel(target.label, { exact: true });
  else if (target.placeholder) locator = root.getByPlaceholder(target.placeholder, { exact: true });
  else if (target.role)
    locator = root.getByRole(target.role as Parameters<Page['getByRole']>[0], {
      name: target.name,
      exact: true,
    });
  else if (target.testId) locator = root.getByTestId(target.testId);
  else if (target.text) locator = root.getByText(target.text, { exact: true });
  else if (target.css) locator = root.locator(target.css);
  else throw new Error('Action needs a semantic target');
  return target.index === undefined ? locator : locator.nth(target.index);
}

export class BrowserHost implements Host {
  id = 'playwright';
  readonly capabilities = [
    'click',
    'fill',
    'type',
    'press',
    'select',
    'check',
    'upload',
    'hover',
    'scroll',
    'drag',
    'navigate',
    'wait',
  ] as const;
  constructor(
    readonly page: Page,
    readonly timeoutMs = 2500,
  ) {
    page.setDefaultTimeout(timeoutMs);
  }
  acceptsIntent() {
    return true;
  }
  async observe() {
    return observation(await this.page.evaluate(readDOM));
  }
  async readField(source: FactSource) {
    const target = source.target
      ? browserLocator(this.page, source.target)
      : this.page.locator('body');
    if ((await target.count()) !== 1 || !(await target.isVisible())) return null;
    return source.from === 'value' ? target.inputValue() : target.innerText();
  }
  async act(action: Action): Promise<void> {
    const target = action.target ? browserLocator(this.page, action.target) : undefined;
    switch (action.kind) {
      case 'navigate':
        await this.page.goto(action.url ?? String(action.value));
        break;
      case 'click':
        if (!target) throw new Error('click needs a target');
        await target.click();
        break;
      case 'fill':
        if (!target) throw new Error('fill needs a target');
        await target.fill(String(action.value ?? ''));
        if (action.submit) await target.press('Enter');
        break;
      case 'type':
        if (!target) throw new Error('type needs a target');
        await target.pressSequentially(String(action.value ?? ''));
        break;
      case 'press':
        if (target) await target.press(String(action.value));
        else await this.page.keyboard.press(String(action.value));
        break;
      case 'select':
        if (!target) throw new Error('select needs a target');
        await target.selectOption(action.value as string | string[]);
        break;
      case 'check':
        if (!target) throw new Error('check needs a target');
        await target.setChecked(Boolean(action.value));
        break;
      case 'upload':
        if (!target) throw new Error('upload needs a target');
        await target.setInputFiles(action.value as string | string[]);
        break;
      case 'hover':
        if (!target) throw new Error('hover needs a target');
        await target.hover();
        break;
      case 'scroll':
        if (target) await target.scrollIntoViewIfNeeded();
        else {
          const v = action.value as { x?: number; y?: number } | undefined;
          await this.page.mouse.wheel(v?.x ?? 0, v?.y ?? 500);
        }
        break;
      case 'drag':
        if (!target || !action.to) throw new Error('drag needs two targets');
        await target.dragTo(browserLocator(this.page, action.to));
        break;
      case 'wait':
        if (target) await target.waitFor({ state: 'visible' });
        else await this.page.waitForLoadState('domcontentloaded');
        break;
      default:
        throw new Error(`Unsupported browser action ${action.kind}`);
    }
  }
}
