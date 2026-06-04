import { describe, it, expect } from 'bun:test';
import { runIsolated } from '../../src/utils/settle.js';

describe('runIsolated', () => {
  it('runs every task even when one rejects, reporting only the failures', async () => {
    const ran: string[] = [];
    const errors: Array<{ label: string; message: string }> = [];

    await runIsolated(
      [
        { label: 'call-end', run: async () => { ran.push('call-end'); } },
        {
          label: 'analytics',
          run: async () => {
            ran.push('analytics');
            throw new Error('redis down');
          },
        },
        { label: 'crm', run: async () => { ran.push('crm'); } },
      ],
      (label, err) => errors.push({ label, message: (err as Error).message }),
    );

    // All three attempted despite the middle one throwing.
    expect(ran.sort()).toEqual(['analytics', 'call-end', 'crm']);
    // Only the failure is reported, labeled.
    expect(errors).toEqual([{ label: 'analytics', message: 'redis down' }]);
  });

  it('reports nothing when all tasks succeed', async () => {
    const errors: string[] = [];
    await runIsolated(
      [
        { label: 'a', run: async () => undefined },
        { label: 'b', run: async () => undefined },
      ],
      (label) => errors.push(label),
    );
    expect(errors).toEqual([]);
  });
});
