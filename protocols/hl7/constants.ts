export const MLLP = {
	SB: 0x0b, // Start Block - Marks the beginning of an HL7 message transmitted over MLLP. Also known as the Vertical Tab (VT) character.

	EB: 0x1c, // End Block - Marks the end of the HL7 message content. Also known as the File Separator (FS) character.

	CR: 0x0d, // Carriage Return - Follows the End Block character to complete the MLLP message terminator.
} as const;
