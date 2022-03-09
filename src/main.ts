import 'ts-polyfill/lib/es2019-array';

import { Kernel } from 'kernel/Kernel';
import { ErrorMapper } from 'utils/ErrorMapper';
import { BasePlanner } from 'processes/BasePlanner';
import { SpawnManager } from 'processes/SpawnManager';
import { CreepManager } from 'processes/CreepManager';

const kernel = new Kernel();
kernel.spawn(SpawnManager, undefined);
kernel.spawn(CreepManager, undefined);
kernel.spawn(BasePlanner, undefined);

// @ts-ignore: to use ps in console
global.ps = (pid?: number) => {
  return kernel.ps(pid);
};

// When compiling TS to JS and bundling with rollup, the line numbers and file names in error messages change
// This utility uses source maps to get the line numbers and file names of the original, TS source code
export const loop = ErrorMapper.wrapLoop(() => {
  kernel.run();

  // Automatically delete memory of missing creeps
  for (const name in Memory.creeps) {
    if (!(name in Game.creeps)) {
      delete Memory.creeps[name];
    }
  }
});
