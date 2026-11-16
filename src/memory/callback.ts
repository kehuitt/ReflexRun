import { observation } from './compiler.js';
import type { Action, ActionKind, Host, Observation } from './types.js';

/** Attach to the original Computer Use tools; no website-specific field map. */
export class CallbackHost implements Host {
  constructor(
    readonly id: string,
    readonly capabilities: readonly ActionKind[],
    readonly ports: {
      observe(options?: { fresh?: boolean }): Promise<Observation>;
      act(action: Action): Promise<void>;
    },
  ) {}
  observe(options?: { fresh?: boolean }) {
    return this.ports.observe(options);
  }
  act(action: Action) {
    return this.ports.act(action);
  }
}

// Chinese accessibility role labels emitted by native hosts.
const chineseRoles = {
  '\u6309\u94ae': 'button',
  '\u5f39\u51fa\u5f0f\u6309\u94ae': 'combobox',
  '\u6587\u672c\u680f': 'textbox',
  '\u6587\u672c': 'text',
  '\u6807\u9898': 'heading',
  '\u94fe\u63a5': 'link',
};
const roleAliases: Record<string, string> = {
  'text field': 'textbox',
  'text area': 'textbox',
  'check box': 'checkbox',
  'push button': 'button',
  ...chineseRoles,
};
const rolePrefix = new RegExp(
  '^(secure text field|text field|text area|pop up button|combo box|radio button|check box|standard window|menu item|menu bar|close button|zoom button|minimize button|button|checkbox|slider|text|window|group|image|link|' +
    Object.keys(chineseRoles).join('|') +
    ')(?:\\s+(.*))?$',
  'i',
);

/** Normalize the visible accessibility text supplied by a native Computer Use host. */
export function fromAccessibility(text: string, scope: string, title = ''): Observation {
  const elements: Observation['elements'] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!m) continue;
    const detail = m[2];
    const prefix = detail
      .split(/(?:Description|Name|Value|ID):/)[0]
      .replace(/\([^)]*\)/g, '')
      .replace(/[,\s]+$/, '')
      .trim();
    const recognized = prefix.match(rolePrefix);
    const rawRole = recognized?.[1] ?? prefix;
    const normalizedRole = rawRole
      .replace(/^AX/, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase();
    const role = Object.hasOwn(roleAliases, normalizedRole)
      ? roleAliases[normalizedRole]
      : normalizedRole;
    const value = detail.match(/Value:\s*(.*?)(?:,\s*(?:ID|Secondary Actions):|$)/)?.[1]?.trim();
    const name =
      detail.match(/(?:Description|Name):\s*([^,]+)/)?.[1]?.trim() ||
      recognized?.[2]?.trim() ||
      (role === 'textbox' ? rawRole : value) ||
      rawRole;
    elements.push({
      ref: m[1],
      role,
      name,
      locator: { role, name },
      ...(value !== undefined ? { value } : {}),
    });
  }
  return observation({ surface: 'native', scope, title, text, elements });
}
