export interface LabeledTask {
  label: string;
  run: () => Promise<unknown>;
}

/**
 * Run independent side-effect tasks concurrently with failure isolation.
 *
 * Every task is attempted regardless of the others' outcomes
 * (Promise.allSettled), and each rejection is reported via `onError` with its
 * label. Use for fan-outs where one failing task must not drop the rest — e.g.
 * the end-of-call queue enqueues, where a Redis blip on the analytics add must
 * not skip the CRM add.
 */
export async function runIsolated(
  tasks: LabeledTask[],
  onError: (label: string, err: unknown) => void,
): Promise<void> {
  const results = await Promise.allSettled(tasks.map((t) => t.run()));
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      onError(tasks[i]!.label, result.reason);
    }
  });
}
