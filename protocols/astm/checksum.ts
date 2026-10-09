/**
 * ASTM Checksum
 *
 * "Add up each byte of FN to <ETB> or <ETX> ... the resulting complement is
 * 0x100, resulting in a hexadecimal number between 0x00-0xff. Two ASCII symbols
 * are used for transport."
 *
 * In other words: sum every byte starting at the frame number through the
 * terminator (ETB/ETX) inclusive, take it mod 256, and render as 2 uppercase
 * hex chars. <STX> itself is NOT included.
 *
 * Worked example from the manual: `<STX>123abc<ETX>` -> `BF`.
 *
 * @param bytes
 * @returns
 */
export function computeAstmChecksum(bytes: Uint8Array): string {
	let sum = 0;
	for (const byte of bytes) {
		sum = (sum + byte) & 0xff;
	}

	return sum.toString(16).toUpperCase().padStart(2, '0');
}
