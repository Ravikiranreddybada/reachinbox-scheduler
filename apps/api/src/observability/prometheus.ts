import { connectedStreamCount } from '../events/stream.js';
import { emailQueue, searchSyncQueue } from '../queues/emailQueue.js';
import { readCounters } from './metrics.js';

/**
 * Prometheus text exposition, written by hand to avoid a client library for
 * a dozen series. Queue gauges come from BullMQ; counters are fleet-wide.
 */
export async function renderMetrics(): Promise<string> {
  const lines: string[] = [];
  const gauge = (name: string, help: string, samples: Array<[string, number]>) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, value] of samples) lines.push(`${name}${labels} ${value}`);
  };

  const queueSamples: Array<[string, number]> = [];
  for (const [queue, name] of [
    [emailQueue, 'email-delivery'],
    [searchSyncQueue, 'search-sync'],
  ] as const) {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'paused');
    for (const [state, value] of Object.entries(counts)) {
      queueSamples.push([`{queue="${name}",state="${state}"}`, value]);
    }
  }
  gauge('reachinbox_queue_jobs', 'BullMQ jobs by queue and state.', queueSamples);

  const [oldestWaiting] = await emailQueue.getJobs(['waiting'], 0, 0, true);
  gauge('reachinbox_queue_oldest_waiting_seconds', 'Age of the oldest ready delivery job.', [
    [
      '',
      oldestWaiting
        ? Math.max(0, (Date.now() - oldestWaiting.timestamp - (oldestWaiting.delay ?? 0)) / 1000)
        : 0,
    ],
  ]);
  gauge('reachinbox_sse_connections', 'Open dashboard event streams on this API process.', [
    ['', connectedStreamCount()],
  ]);

  const counters = await readCounters();
  const byName = new Map<string, Array<[string, number]>>();
  for (const [field, value] of Object.entries(counters)) {
    const brace = field.indexOf('{');
    const name = brace === -1 ? field : field.slice(0, brace);
    const labels = brace === -1 ? '' : field.slice(brace);
    byName.set(name, [...(byName.get(name) ?? []), [labels, value]]);
  }
  for (const [name, samples] of byName) {
    lines.push(`# TYPE reachinbox_${name} counter`);
    for (const [labels, value] of samples) lines.push(`reachinbox_${name}${labels} ${value}`);
  }
  return `${lines.join('\n')}\n`;
}
