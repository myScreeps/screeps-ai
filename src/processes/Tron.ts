import { Process, Thread } from '../kernel/Process';
import { fork, hibernate } from '../kernel/sys-calls';
import { Init } from './Init';

export class Tron extends Process<undefined> {
  *run(): Thread {
    if (!this.hasChildOfType(Init)) {
      yield* fork(Init, undefined);
    }
    yield* hibernate();
  }
}
