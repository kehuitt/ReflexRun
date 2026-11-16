import type { Candidate, Fact, FactFormat, Policy, Verdict } from './types.js';

export function parseFact(raw: string | null, format: FactFormat = 'text'): Fact {
  if (raw === null || !raw.trim()) return null;
  const text = raw.trim();
  switch (format) {
    case 'text':
      return text;
    case 'number':
      return /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
    case 'money': {
      const m = text.match(/^(?:¥|\uffe5|\$)?\s*(\d+(?:\.\d+)?)$/);
      return m ? Number(m[1]) : null;
    }
    case 'distance': {
      // Accept both Latin abbreviations and Chinese distance units.
      const m = text.match(/^(\d+(?:\.\d+)?)\s*(km|m|\u516c\u91cc|\u7c73)$/i);
      return m ? Number(m[1]) / (/^(m|\u7c73)$/i.test(m[2]) ? 1000 : 1) : null;
    }
  }
}

export function validatePolicy(policy: Policy): void {
  if (!Number.isInteger(policy.revision) || policy.revision < 1 || !Array.isArray(policy.rules)) {
    throw new Error('A policy needs a positive integer revision and a rules array.');
  }
  for (const r of policy.rules) {
    if (!r.field || !['eq', 'lte', 'gte', 'in', 'not-in'].includes(r.op))
      throw new Error('Invalid policy rule.');
    if ((r.op === 'in' || r.op === 'not-in') && !Array.isArray(r.value))
      throw new Error('Membership rules need an array.');
    if (
      (r.op === 'lte' || r.op === 'gte') &&
      (typeof r.value !== 'number' || !Number.isFinite(r.value))
    )
      throw new Error('Bounds need a finite number.');
  }
}

/** Freeze preferences once per revision; item values are still read at the effect boundary. */
export function compilePolicy(policy: Policy): (candidate: Candidate) => Verdict {
  validatePolicy(policy);
  const revision = policy.revision;
  const rules = policy.rules.map((r) => {
    const values = Array.isArray(r.value) ? new Set(r.value) : undefined;
    const value = r.value;
    const test = (actual: Fact) =>
      r.op === 'eq'
        ? actual === value
        : r.op === 'in'
          ? values!.has(actual)
          : r.op === 'not-in'
            ? !values!.has(actual)
            : typeof actual !== 'number'
              ? undefined
              : r.op === 'lte'
                ? actual <= (value as number)
                : actual >= (value as number);
    return { field: r.field, reason: `${r.field} ${r.op} ${JSON.stringify(value)}`, test };
  });
  return (candidate) => {
    let missing: string | undefined;
    for (const rule of rules) {
      const value = candidate.facts[rule.field];
      if (value === null || value === undefined) {
        missing = rule.field;
        continue;
      }
      const verdict = rule.test(value);
      if (verdict === undefined) missing = rule.field;
      else if (!verdict) return { decision: 'deny', reason: rule.reason };
    }
    return missing
      ? { decision: 'unknown', reason: `Missing or invalid fact: ${missing}` }
      : { decision: 'allow', reason: `Policy v${revision}` };
  };
}
