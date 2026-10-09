/** Orderable analysis CBC parameter catalog for Sysmex KX-21 / KX-21N host output. */

export const SYSMEX_KX21N_MODELS = [
	'Sysmex KX-21N',
	// 'Sysmex KX-21',
	// 'KX-21N',
	// 'KX-21',
] as const;

/**
 * The analyzer performs one orderable analysis. WBC, RBC, HGB, and the other
 * hematology parameters are results within this panel, not separate orders.
 */
export const SYSMEX_KX21N_ORDER_CATALOG = [{
	code: 'CBC',
	name: 'Complete Blood Count (CBC)',
}] as const;
