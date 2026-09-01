import { describe, expect, it } from 'vitest';

import {
  activitySummary,
  addActivity,
  removeActivity,
  type Activity,
} from '../src/state/activity.js';

describe('application activity', () => {
  it('keeps earlier work visible when overlapping work finishes first', () => {
    let activities: readonly Activity[] = [];
    activities = addActivity(activities, { id: 1, label: 'Syncing workspace…' });
    activities = addActivity(activities, { id: 2, label: 'Preparing reference…' });

    expect(activitySummary(activities)).toBe('Preparing reference… · 1 more task');

    activities = removeActivity(activities, 2);
    expect(activitySummary(activities)).toBe('Syncing workspace…');

    activities = removeActivity(activities, 1);
    expect(activitySummary(activities)).toBeNull();
  });

  it('removes operations by identity rather than completion order', () => {
    const activities = [
      { id: 1, label: 'First task…' },
      { id: 2, label: 'Second task…' },
      { id: 3, label: 'Third task…' },
    ];

    expect(activitySummary(removeActivity(activities, 2))).toBe(
      'Third task… · 1 more task',
    );
  });
});
