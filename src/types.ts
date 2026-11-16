export type Fact = string | number | boolean | null;
export type Candidate = { id: string; label: string; facts: Record<string, Fact> };

export type FactFormat = 'text' | 'number' | 'distance' | 'money';

export type Rule = {
  field: string;
  op: 'eq' | 'lte' | 'gte' | 'in' | 'not-in';
  value: Fact | Fact[];
};
export type Policy = { revision: number; rules: Rule[] };
export type Verdict = { decision: 'allow' | 'deny' | 'unknown'; reason: string };
export type Outcome = 'reserved' | 'attempted' | 'confirmed' | 'rejected' | 'unknown';
export type Entry = {
  key: string;
  id: string;
  label: string;
  state: Outcome;
  revision: number;
  at: string;
  note?: string;
};
export interface Journal {
  get(key: string): Entry | undefined;
  entries(): Entry[];
  put(entry: Entry): Promise<void>;
  acquire(): Promise<() => Promise<void>>;
}
