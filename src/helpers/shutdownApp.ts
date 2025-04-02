import { getLogger } from "./logger";

export async function ShutdownApp(code: number) {
	let logger = await getLogger();

	logger.info("Exiting application with code: " + code);

	if (logger.close) {
		await new Promise<void>((resolve) => {
			logger.on('finish', resolve);
			logger.close();
		});
	}

	process.exit(code);
}