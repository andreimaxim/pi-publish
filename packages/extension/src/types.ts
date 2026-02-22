export interface Trace {
  id: string;
  title: string;
  date: string;
  totalCost: number;
  turns: Turn[];
}

export interface Turn {
  prompt: string;
  completion: Completion;
  metadata: Metadata;
}

export interface Completion {
  steps: Step[];
  response: string;
}

export type Step = Narration | Action;

export interface Narration {
  type: "narration";
  text: string;
}

export interface Action {
  type: "action";
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  output?: string;
}

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface Metadata {
  model: string;
  thinkingLevel?: ThinkingLevel;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  elapsed: number;
}
