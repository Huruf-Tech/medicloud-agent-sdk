// import { machineRegistry } from '../registry.ts';
// import type { IFlash3000Config } from '../types.ts';
// import {
// 	IFlash3000,
// 	iFlash3000MachineId,
// 	iFlash3000Schema,
// } from './iflash/iFlash3000.ts';

/**
 * Here register all machines/drivers.
 * Registration here is first required locally otherwise (create) will not work
 */
// machineRegistry.register<IFlash3000Config>({
// 	id: iFlash3000MachineId, // this will become the MachineDriverId
// 	// brand: "iFlash",
// 	// models: ["3000"],
// 	brand: 'YHLO',
// 	models: ['YHLO iFlash 3000', 'iFlash 3000'],
// 	configSchema: iFlash3000Schema,
// 	create(profile) {
// 		return new IFlash3000(profile.config);
// 	},
// });

// export * from './iflash/iFlash3000.ts';

import { machineRegistry } from '../registry.ts';
import { IFlash3000 } from './iflash/index.ts';
import { Maglumi800 } from './maglumi800/index.ts';
import { RocheCobasC111 } from './rocheCobasC111/index.ts';
import { SysmexKx21n } from './sysmexKx21n/index.ts';
import { DrAccuAfi6100b } from './draccuAfi6100b/index.ts';
import { BiolaboKenza } from './biolaboKenza/index.ts';

/**
 * Here register every available driver/machine class here. Each class owns its metadata,
 * configuration schema, construction, and runtime behavior.
 */
machineRegistry.register(IFlash3000);
machineRegistry.register(Maglumi800);
machineRegistry.register(RocheCobasC111);
machineRegistry.register(SysmexKx21n);
machineRegistry.register(BiolaboKenza);
machineRegistry.register(DrAccuAfi6100b);

export * from './iflash/index.ts';
export * from './maglumi800/index.ts';
export * from './rocheCobasC111/index.ts';
export * from './sysmexKx21n/index.ts';
export * from './biolaboKenza/index.ts';
export * from './draccuAfi6100b/index.ts';
