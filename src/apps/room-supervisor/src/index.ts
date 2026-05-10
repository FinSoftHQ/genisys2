import { startSupervisorServer } from "./server.js";

async function main() {
	const server = await startSupervisorServer();
	server.on("error", (err) => {
		console.error("[supervisor] server error:", err);
		process.exit(1);
	});
}

main().catch((err) => {
	console.error("[supervisor] fatal error:", err);
	process.exit(1);
});
