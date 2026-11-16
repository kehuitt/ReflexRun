import { check, decode } from './compiler.js';
import type { ExperienceStore } from './store.js';
import type { Action, AgentTools, Check, Composition, Experience, Host, Task } from './types.js';
import { replayActions } from './program.js';

/** Local composition is admitted by actual execution and boundary checks, never by concatenation alone. */
export async function executeComposition(
  tools: AgentTools,
  task: Task,
  plan: Composition,
  store: ExperienceStore,
  host?: Host,
): Promise<Experience['parts']> {
  if (!plan.parts.length) throw new Error('A composition needs at least one segment');
  const provenance: NonNullable<Experience['parts']> = [];
  const admitted = [];
  for (const part of plan.parts) {
    const memory = await store.get(part.experience);
    if (!memory) throw new Error('A composition cannot use a missing or quarantined experience');
    if (
      !Number.isInteger(part.start) ||
      !Number.isInteger(part.end) ||
      part.start < 0 ||
      part.end > memory.steps.length ||
      part.start >= part.end
    )
      throw new Error('Invalid experience segment boundaries');
    for (const key of memory.requiredInputs)
      if (!Object.hasOwn(task.inputs, key)) throw new Error(`Missing composition input ${key}`);
    if (
      Object.entries(memory.when ?? {}).some(
        ([key, value]) => JSON.stringify(task.inputs[key]) !== JSON.stringify(value),
      )
    )
      throw new Error('Composition input branch does not match');
    if (
      JSON.stringify(
        memory.constraints === undefined ? undefined : decode(memory.constraints, task.inputs),
      ) !== JSON.stringify(task.constraints)
    )
      throw new Error('Composition constraints do not match');
    const steps = memory.steps.slice(part.start, part.end);
    const actions = host
      ? replayActions(memory, host, task.inputs, steps)
      : steps.map((step) => ({
          ...(decode(step.action, task.inputs) as Action),
          effect: step.effect,
        }));
    if (!actions) throw new Error('This host cannot execute the selected segment');
    admitted.push({ part, memory, actions });
  }
  for (const [i, { part, memory, actions }] of admitted.entries()) {
    if (i === 0 && memory.entryUrl) {
      const url = String(decode(memory.entryUrl, task.inputs));
      if ((await tools.observe()).url !== url)
        await tools.act({ kind: 'navigate', url, effect: false });
    }
    const requires = decode(
      part.requires as unknown as import('./types.js').Json,
      task.inputs,
    ) as Check;
    const state = await tools.observe({ fresh: true });
    if (
      !check(state, requires) ||
      (part.start === 0 &&
        memory.applicability &&
        !check(state, decode(memory.applicability, task.inputs) as Check))
    )
      throw new Error(`Segment ${part.segment} precondition does not hold`);
    for (const action of actions) await tools.act(action);
    const ensures = decode(
      part.ensures as unknown as import('./types.js').Json,
      task.inputs,
    ) as Check;
    if (!check(await tools.observe({ fresh: true }), ensures))
      throw new Error(`Segment ${part.segment} postcondition does not hold`);
    provenance.push({
      experience: memory.id,
      segment: part.segment,
      start: part.start,
      end: part.end,
    });
  }
  return provenance;
}
