import type { AstmProtocolOptions } from '../../protocols/astm/link.ts';

export const MAGLUMI_800_ASTM_OPTIONS = {
	receiveFrameNumber: 'optional',
	receiveChecksum: 'none',
	sendFrameNumber: false,
	sendChecksum: false,
	intermediateTerminator: 'etx',
	finalTerminator: 'etx',
	sendRecordsInSingleFrame: true,
	reassembleEtbFrames: false,
} satisfies AstmProtocolOptions;
