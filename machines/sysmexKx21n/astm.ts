import { SysmexKx21nAstmOptions } from '../../protocols/astm/variants/sysmexKx21n.ts';

export { SysmexKx21nAstmProtocol } from '../../protocols/astm/variants/sysmexKx21n.ts';
export type { SysmexKx21nFrame } from '../../protocols/astm/variants/sysmexKx21n.ts';

/** Machine-owned option selection, byte/session behavior lives in the variant. */
export const SYSMEX_KX21N_ASTM_OPTIONS = {
	classB: true,
} satisfies SysmexKx21nAstmOptions;
