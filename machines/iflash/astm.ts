import type { AstmProtocolOptions } from '../../protocols/astm/link.ts';

export const IFLASH_ASTM_OPTIONS = {
	receiveFrameNumber: 'required',
	receiveChecksum: 'required',
	sendFrameNumber: true,
	sendChecksum: true,
	intermediateTerminator: 'etx',
	finalTerminator: 'etb',
	sendRecordsInSingleFrame: false,
	reassembleEtbFrames: false,
} satisfies AstmProtocolOptions;
