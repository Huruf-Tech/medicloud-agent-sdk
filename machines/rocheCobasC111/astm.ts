import type { CobasC111SerialAstmOptions } from '../../protocols/astm/variants/cobasC111Serial.ts';

export { CobasC111SerialAstmProtocol } from '../../protocols/astm/variants/cobasC111Serial.ts';

export const ROCHE_COBAS_C111_ASTM_OPTIONS = {
	maxFrameTextLength: 240,
	sendGapMs: 120,
} satisfies CobasC111SerialAstmOptions;

// const DEFAULT_CONFIG = {
//     serialPort: 'COM3',
//     baud: 9600,
//     dataBits: 8,
//     stopBits: 1,
//     parity: 'n',
//     flowControl: 'xonxoff',
//     reconnectDelayMs: 5000,
//     replyToQueries: false,
//     pushOrders: false,
//     pushIntervalMs: 1000,
//     resultPollingEnabled: true,
//     resultPollInitialDelayMs: 60_000,
//     resultPollIntervalMs: 60_000,
//     estimatedMinutes: 12,
//     hostSenderName: 'ASTM-Host',
//     analyzerName: 'c111',
//     defaultComment: 'Default TS',
//     trace: false,
// } as const;
