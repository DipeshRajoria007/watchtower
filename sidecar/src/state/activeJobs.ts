/** Active jobs tracked for cancellation support. Maps jobId → AbortController. */
const activeJobs = new Map<string, AbortController>();

export function registerActiveJob(jobId: string, controller: AbortController): void {
  activeJobs.set(jobId, controller);
}

export function unregisterActiveJob(jobId: string): void {
  activeJobs.delete(jobId);
}

export function cancelJob(jobId: string): boolean {
  // Exact match first
  const exactMatch = activeJobs.get(jobId);
  if (exactMatch) {
    exactMatch.abort();
    activeJobs.delete(jobId);
    return true;
  }
  // Try prefix match (same pattern as resolveJobId in jobStore)
  for (const [key, controller] of activeJobs) {
    if (key.startsWith(jobId)) {
      controller.abort();
      activeJobs.delete(key);
      return true;
    }
  }
  return false;
}

export function getActiveJobIds(): string[] {
  return Array.from(activeJobs.keys());
}
