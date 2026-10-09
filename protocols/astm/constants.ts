export const ASTM_CONTROL = {
	ENQ: 0x05, // Enquiry - Initiates communication. The sender asks, "Are you ready to receive data?"

	ACK: 0x06, // Acknowledge - Indicates that the last message or frame was received successfully.

	NAK: 0x15, // Negative Acknowledge - Indicates that the frame was not received correctly (checksum error, timeout, etc.)

	EOT: 0x04, // End of Transmission - Ends the communication session. Sent after the last frame has been acknowledged.

	STX: 0x02, // Start of Text - Marks the beginning of a data frame. Everything after this (until ETX or ETB) is considered frame data.

	ETX: 0x03, // End of Text - Marks the end of the final frame's text. The checksum is calculated up to and including this character.

	ETB: 0x17, // End of Transmission Block - Marks the end of an intermediate frame when a message spans multiple frames. More frames will follow.

	CR: 0x0d, // Carriage Return - Terminates a record within the ASTM message. Every record ends with CR.

	LF: 0x0a, // Line Feed - Usually follows CR to complete the record terminator (CRLF). Some instruments ignore it, but ASTM specifies CRLF.
} as const;

/**
 * Delimiters declared in the H record (`H|\^&|...`).
 * - field:      `|`
 * - repeat:     `\`
 * - component:  `^`
 * - escape:     `&`
 */
export const ASTM_DELIMITER = {
	FIELD: '|',
	REPEAT: '\\',
	COMPONENT: '^',
	ESCAPE: '&',
} as const;

/** Highest ASTM frame number before it wraps back to 0. */
export const ASTM_MAX_FRAME_NUMBER = 7;
