import { z } from 'zod';
import { validPartialName } from './compiler.js';
export const locator = z
  .object({
    ref: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    nameIncludes: z.string().min(1).optional(),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    testId: z.string().optional(),
    css: z.string().optional(),
    text: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
    frames: z.array(z.string()).optional(),
    within: z.string().optional(),
  })
  .strict()
  .refine((target) => target.nameIncludes === undefined || validPartialName(target), {
    message: 'Partial names need a role and cannot mix exact, CSS, ref or ordinal targets',
  });
export const actionSchema = z
  .object({
    kind: z.enum([
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
      'tool',
    ]),
    input: z.string().optional(),
    submit: z.boolean().optional(),
    target: locator.optional(),
    to: locator.optional(),
    value: z.json().optional(),
    url: z.string().optional(),
    tool: z.string().optional(),
    args: z.record(z.string(), z.json()).optional(),
    effect: z.boolean().optional(),
  })
  .strict();
export const checkSchema = z
  .object({
    text: z.string().optional(),
    urlIncludes: z.string().optional(),
    target: locator.optional(),
    equals: z.json().optional(),
  })
  .strict();
