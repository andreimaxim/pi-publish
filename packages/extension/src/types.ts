export interface PublishedSession {
  session: {
    id: string;
    title: string;
    date: string;
    totalCost: number;
  };
  turns: Turn[];
}

export interface Turn {
  prompt: string;
  steps: Step[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  elapsed: number;
}

export type Step = ThinkingStep | TextStep | ToolStep;

export interface ThinkingStep {
  type: "thinking";
  text: string;
}

export interface TextStep {
  type: "text";
  text: string;
}

export interface ToolStep {
  type: "tool";
  name: string;
  args: string;
  ok: boolean;
  output?: string;
  diff?: {
    path: string;
    oldText: string;
    newText: string;
  };
}
