import { decode } from './compiler.js';
import { extractFacts } from './facts.js';
import type { FactPlan, FactSource, Host, Inputs, Json, Readback } from './types.js';

export type ReadbackPlan = {
  url: string;
  identity: FactSource & { expected: Json };
  fields: Record<string, FactSource & { expected: Json }>;
};

/** Called on an independent record-view host, not on the application's success toast. */
export async function readRecord(
  host: Host,
  template: ReadbackPlan,
  inputs: Inputs,
  allowedScopes: string[],
): Promise<Readback> {
  const plan = decode(template as unknown as Json, inputs) as ReadbackPlan;
  if (!allowedScopes.includes(new URL(plan.url).origin))
    throw new Error('Readback URL is outside the authorized scope');
  await host.act({ kind: 'navigate', url: plan.url, effect: false });
  const state = await host.observe({ fresh: true });
  if (!allowedScopes.includes(state.scope)) throw new Error('Readback left the authorized scope');
  const values = await extractFacts(plan as FactPlan, state, host);
  if (!values.identityMatches || Object.values(values.facts).some((v) => v === null))
    return { status: 'unknown', source: plan.url };
  const matches = Object.entries(plan.fields).every(
    ([key, field]) => JSON.stringify(values.facts[key]) === JSON.stringify(field.expected),
  );
  return { status: matches ? 'confirmed' : 'rejected', source: plan.url };
}
