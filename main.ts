import { env } from './lib/utils.ts';
import { MachineManager } from './machineManager.ts';

const manager = new MachineManager({
	http: {
		enabled: env('MEDICLOUD_MACHINES_HTTP_ENABLED', true),
		host: env('MEDICLOUD_MACHINES_HTTP_HOST', 'localhost'),
		port: env('MEDICLOUD_MACHINES_HTTP_PORT', 5001),
	},
	dbPath: env('MEDICLOUD_MACHINES_DB_PATH', './data/machines.db'),
});

const handler = await manager.getHandler();

// const handler = () => {
// 	return async (req: Request): Promise<Response> => {
// 		const url = new URL(req.url);
// 		const segments = url.pathname.split('/').filter(Boolean);
// 		const method = req.method.toUpperCase();

// 		try {
// 			// GET /health
// 			if (method === "GET" && segments.length === 1 && segments[0] === "health") {
// 				return json({
// 					status: 'ok',
// 				});
// 			}

// 			return json({ error: 'not found' }, 404);
// 		} catch (error) {
// 			if (error instanceof HttpError) {
// 				return json({ error: error.message }, error.status);
// 			}
// 			return json(
// 				{ error: "internal error", detail: errorMessage(error) },
// 				500,
// 			);
// 		}
// 	}
// }

Deno.serve(
	{
		hostname: "0.0.0.0",
		port: 5001,
		onListen: ({ hostname, port }) => {
			console.info(
				`HTTP server listening on http://${hostname}:${port}`,
			);
		},
	},
	handler,
);

// shutdown machineManager
let shutdownStarted = false;
function removeSignalListeners(): void {
	Deno.removeSignalListener('SIGINT', onSigInt);
	if (Deno.build.os !== 'windows') {
		Deno.removeSignalListener('SIGTERM', onSigTerm);
	}
}
async function shutdown(signal: string): Promise<void> {
	if (shutdownStarted) return;
	shutdownStarted = true;

	removeSignalListeners();
	console.log(`${signal} received; shutting down...`);
	try {
		await manager.shutdown();
	} catch (error) {
		console.error('shutdown failed', error);
		Deno.exitCode = 1;
	}
}
const onSigInt = () => void shutdown('SIGINT');
const onSigTerm = () => void shutdown('SIGTERM');

Deno.addSignalListener('SIGINT', onSigInt);
if (Deno.build.os !== 'windows') {
	Deno.addSignalListener('SIGTERM', onSigTerm);
}

// // Start the built-in Deno server.
// await manager.listen(() => {
// 	//...
// 	console.log('server is running!');
// });
