import { parseFact } from '../policy.js';
import { elementFor } from './compiler.js';
import type { Fact } from '../types.js';
import type { FactPlan, FactSource, Host, Observation } from './types.js';

/** A plan is generated once; normal evaluation uses only current host observations. */
export async function extractFacts(plan: FactPlan, state: Observation, host: Host) {
  const sources = [...Object.values(plan.fields), ...(plan.identity ? [plan.identity] : [])];
  const body =
    sources.some((s) => !s.target) && host.readField
      ? await host.readField({ from: 'text' })
      : state.text;
  const read = async (source: FactSource): Promise<Fact> => {
    let raw: string | null;
    if (!source.target) raw = body;
    else if (host.readField) raw = await host.readField(source);
    else {
      const element = elementFor(source.target, state);
      raw = element ? (source.from === 'text' ? element.name : (element.value ?? null)) : null;
    }
    if (raw === null) return null;
    if (source.pattern) {
      const matches = [...raw.matchAll(new RegExp(source.pattern, 'g'))];
      if (matches.length !== 1) return null;
      const match = matches[0];
      raw = match[1] ?? match[0];
    }
    if (source.parse === 'boolean')
      return /^(true|yes|1)$/i.test(raw.trim())
        ? true
        : /^(false|no|0)$/i.test(raw.trim())
          ? false
          : null;
    return parseFact(raw, source.parse ?? 'text');
  };
  const facts = Object.fromEntries(
    await Promise.all(
      Object.entries(plan.fields).map(async ([key, source]) => [key, await read(source)]),
    ),
  );
  const identity = plan.identity ? await read(plan.identity) : undefined;
  return {
    facts,
    identity,
    identityMatches:
      !plan.identity || (identity !== null && String(identity) === String(plan.identity.expected)),
  };
}
