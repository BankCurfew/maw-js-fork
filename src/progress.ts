// Oracle progress tracking — stub module

export interface OracleProgress {
  oracle: string;
  status: string;
  updatedAt: string;
}

const progressMap = new Map<string, OracleProgress>();

export function readProgress(): OracleProgress[] {
  return [...progressMap.values()];
}

export function getOracleProgress(oracle: string): OracleProgress | undefined {
  return progressMap.get(oracle);
}

export function updateProgress(oracle: string, status: string) {
  progressMap.set(oracle, { oracle, status, updatedAt: new Date().toISOString() });
}
