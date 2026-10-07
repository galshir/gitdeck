import * as http from 'http';
import { alive } from './runner';

export type Status = 'running' | 'starting' | 'crashed' | 'stopped';

export function probe(port: number, urlPath = '/'): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port, path: urlPath, timeout: 1500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => req.destroy());
  });
}

/** Any HTTP response counts as up; a server started outside the extension still shows as running. */
export async function serviceStatus(pid: number | undefined, port: number, healthPath?: string): Promise<Status> {
  if (await probe(port, healthPath)) return 'running';
  if (alive(pid)) return 'starting';
  return pid ? 'crashed' : 'stopped';
}

/** The status that most needs attention wins. */
export function aggregate(statuses: Status[]): Status {
  return (['crashed', 'starting', 'running'] as Status[]).find((s) => statuses.includes(s)) ?? 'stopped';
}
