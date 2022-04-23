import type { Logger } from '../Logger';
import type { Scheduler, SchedulerThreadReturn } from './Scheduler';
import {
  createProcess,
  hibernate,
  JSONPointer,
  JSONValue,
  Process,
  ProcessInfo,
  SysCallResults,
  Thread,
} from '../system';
import { getMemoryRef } from './memory';
import { OSExit } from './errors';

const ArgsMemoryKey = '__args';

export type PID = number & {
  __: 'PID';
};

type ProcessMemory = {
  [ArgsMemoryKey]: JSONValue[];
  [k: string]: JSONPointer;
};

type ProcessDescriptor = {
  type: string;
  pid: PID;
  parent: PID;
  memory: ProcessMemory;
};

type PackedProcessDescriptor = [
  type: string,
  pid: PID,
  parent: PID,
  memory: ProcessMemory
];

const packEntry = (entry: ProcessDescriptor): PackedProcessDescriptor => [
  entry.type,
  entry.pid,
  entry.parent,
  entry.memory,
];

const unpackEntry = (entry: PackedProcessDescriptor): ProcessDescriptor => ({
  type: entry[0],
  pid: entry[1],
  parent: entry[2],
  memory: entry[3],
});

type ProcessTable = Record<PID, PackedProcessDescriptor>;

const tron = createProcess(function* () {
  // TODO: Log global reset
  yield* hibernate();
});

export class Kernel {
  private readonly tableRef = getMemoryRef<ProcessTable>('processTable', {});
  private get table(): ProcessTable {
    return this.tableRef.get();
  }
  private getProcessDescriptor(pid: PID): ProcessDescriptor {
    const descriptor = this.table[pid];
    if (!descriptor) {
      throw new Error(`Attempted to access non-existent process ${pid}`);
    }

    return unpackEntry(descriptor);
  }
  private setProcessDescriptor(descriptor: ProcessDescriptor): void {
    this.table[descriptor.pid] = packEntry(descriptor);
  }

  get pids(): PID[] {
    return Object.keys(this.table).map((k) => Number.parseInt(k) as PID);
  }

  private readonly threads = new Map<PID, Thread>();

  constructor(
    private readonly registry: Record<string, Process<never>>,
    private readonly scheduler: Scheduler,
    private readonly logger: Logger
  ) {
    if (!this.table[0 as PID]) {
      this.logger.warn('tron missing');
      this.reboot();
    } else {
      for (const pid of this.pids) {
        this.initThread(pid);
      }
    }
    this.PIDCount = Math.max(0, ...this.pids) as PID;
  }

  reboot() {
    this.logger.info('Rebooting...');

    for (const pid of this.pids) {
      this.scheduler.remove(pid);
    }

    this.tableRef.set({});
    this.createProcess('tron' as never, [], 0 as PID, 0 as PID);
    this.createProcess('init', [], 1 as PID, 0 as PID);
  }

  private PIDCount: PID;
  private acquirePID(): PID {
    if (this.PIDCount >= 50000) {
      this.PIDCount = 0 as PID;
    }
    ++this.PIDCount;
    if (this.table[this.PIDCount]) {
      return this.acquirePID();
    }
    return this.PIDCount;
  }

  private createProcess(
    type: string,
    args: JSONValue[],
    pid: PID,
    parent: PID
  ) {
    // istanbul ignore next
    if (pid in this.table) {
      throw new Error(`PID already occupied: ${pid}`);
    }

    this.setProcessDescriptor({
      type,
      pid,
      parent,
      memory: {
        [ArgsMemoryKey]: args,
      },
    });

    this.initThread(pid);
  }

  private initThread(pid: PID) {
    const { type, memory } = this.getProcessDescriptor(pid);
    const process = type === 'tron' ? tron : this.registry[type];
    if (!process) {
      this.kill(pid);
      this.logger.error(
        `Error trying to initialise pid ${pid} with unknown type ${type}`
      );
      return;
    }

    const args = memory[ArgsMemoryKey] as [];
    this.threads.set(pid, process(...args));
    this.scheduler.add(pid);
  }

  private findChildren(pid: PID): ProcessDescriptor[] {
    return Object.values(this.table)
      .map((v) => unpackEntry(v))
      .filter(({ parent }) => parent === pid);
  }

  public kill(pid: PID) {
    if (pid === 0) {
      this.logger.alert('Trying to kill Tron, rebooting...');
      this.reboot();
      return;
    }

    this.threads.delete(pid);
    delete this.table[pid];
    this.scheduler.remove(pid);

    // Orphans are killed
    this.findChildren(pid).forEach((child) => {
      this.kill(child.pid);
    });
  }

  private runThread(pid: PID): SchedulerThreadReturn {
    const thread = this.threads.get(pid);
    if (!thread) {
      this.logger.error(`Attempting to run ${pid} with missing thread.`);
      this.kill(pid);
      return undefined;
    }

    let nextArg: SysCallResults = undefined;
    for (;;) {
      const sysCall = thread.next(nextArg);
      nextArg = undefined;

      if (sysCall.done) {
        this.kill(pid);
        return undefined;
      }

      if (!sysCall.value) {
        return undefined;
      }

      switch (sysCall.value.type) {
        case 'sleep': {
          return sysCall.value;
        }
        case 'fork': {
          const { args, processType } = sysCall.value;
          const childPID = this.acquirePID();
          this.createProcess(processType, args, childPID, pid);
          nextArg = { type: 'fork', pid: childPID };
          this.logger.info(`PID ${pid} forked ${processType}:${childPID}`);
          break;
        }
        case 'kill': {
          const { pid: childPID } = sysCall.value;
          if (!this.findChildren(pid).some((child) => child.pid === childPID)) {
            break;
          }
          this.kill(childPID);
          break;
        }
        case 'allocate': {
          const descriptor = this.getProcessDescriptor(pid);
          nextArg = { type: 'allocate', pointer: descriptor.memory };
          break;
        }
        case 'children': {
          const children = this.findChildren(pid).reduce<
            Record<PID, ProcessInfo>
          >(
            (acc, { pid, type, memory }) => ({
              ...acc,
              [pid]: { pid, type, args: memory[ArgsMemoryKey] },
            }),
            {}
          );
          nextArg = { type: 'children', children };
          break;
        }
      }
    }
  }

  public run(): void {
    const schedule = this.scheduler.run();
    let nextArg: SchedulerThreadReturn = undefined;
    for (;;) {
      const next = schedule.next(nextArg);
      if (next.done) {
        break;
      }

      const pid = next.value;
      const entry = this.getProcessDescriptor(pid);
      this.logger.verbose(`Running thread ${entry.type}:${pid}`);
      const startCPU = Game.cpu.getUsed();
      try {
        nextArg = this.runThread(pid);
      } catch (err) {
        this.kill(pid);
        if (err instanceof OSExit) {
          this.logger.debug(
            `${entry.type}:${pid} exited with reason: ${err.message}`
          );
          continue;
        }
        // TODO: Better error handling
        this.logger.error(
          `Error while running ${entry.type}:${pid}\n${
            /*ErrorMapper.sourceMappedStackTrace(err as Error)*/ ''
          }`
        );
        continue;
      }
      const endCpu = Game.cpu.getUsed();
      this.logger.verbose(`${entry.type}:${pid} ${nextArg?.type ?? 'yield'}`);
      // TODO
      // recordStats({
      //   threads: {
      //     [entry.type]: {
      //       [pid]: endCpu - startCPU,
      //     },
      //   },
      // });
    }
  }

  /* istanbul ignore next */
  public ps(pid = 0 as PID) {
    const tableByParent = _.groupBy(
      Object.values(this.table)
        .map(unpackEntry)
        .filter(({ pid }) => pid !== 0),
      'parent'
    );

    const getSubTree = (prefix: string, pid: PID, end: boolean): string => {
      const entry = this.getProcessDescriptor(pid);
      const { type } = entry;

      const header = `${prefix}${end ? '`-- ' : '|-- '}${type}:${pid}`;

      const children = tableByParent[pid] ?? [];
      children.sort((a, b) => a.pid - b.pid);
      const childTree = children.map(({ pid }, i) =>
        getSubTree(
          prefix + (end ? '    ' : '|    '),
          pid,
          i === children.length - 1
        )
      );

      return `${header}\n${childTree.join('')}`;
    };

    return getSubTree('', pid, true);
  }
}