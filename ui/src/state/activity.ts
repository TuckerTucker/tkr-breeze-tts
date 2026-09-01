/**
 * Concurrent application activity state.
 *
 * Each asynchronous operation owns one stable identifier. Removing one
 * operation therefore cannot hide another operation that is still running.
 * The most recently started task supplies the contextual copy while the count
 * preserves visibility of overlapping background work.
 *
 * @module
 */

/** One asynchronous operation currently owned by the application shell. */
export interface Activity {
  readonly id: number;
  readonly label: string;
}

/** Add an operation without mutating the current collection. */
export function addActivity(
  activities: readonly Activity[],
  activity: Activity,
): readonly Activity[] {
  return [...activities, activity];
}

/** Remove exactly the operation that completed. */
export function removeActivity(
  activities: readonly Activity[],
  id: number,
): readonly Activity[] {
  return activities.filter((activity) => activity.id !== id);
}

/**
 * Build the one line shown by the global indicator.
 *
 * @returns Contextual copy, or null when the application is idle.
 */
export function activitySummary(activities: readonly Activity[]): string | null {
  const current = activities.at(-1);
  if (!current) return null;

  const additional = activities.length - 1;
  if (additional === 0) return current.label;

  return `${current.label} · ${additional} more ${additional === 1 ? 'task' : 'tasks'}`;
}
