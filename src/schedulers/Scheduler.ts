import type { PID } from 'kernel';

export type SchedulerThreadReturn =
  | { type: 'sleep'; ticks: number }
  | undefined;

export type ScheduleGenerator = Generator<PID, void, SchedulerThreadReturn>;

export interface Scheduler {
  add(pid: PID): void;
  remove(pid: PID): void;
  run(): ScheduleGenerator;
}
