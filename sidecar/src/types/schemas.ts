export type PrReviewCodexOutput = {
  status: 'success' | 'no_findings';
  summary: string;
  prUrl: string;
};

export type BugFixCodexOutput = {
  status: 'success';
  summary: string;
  prUrl: string;
  branch: string;
  tests: string[];
};

export type OwnerAutopilotCodexOutput = {
  status: 'success' | 'failed' | 'no_action';
  summary: string;
  actions: string[];
  prUrl: string;
};
