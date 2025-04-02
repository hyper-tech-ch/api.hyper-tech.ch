import fs from 'fs';
import path from 'path';
import winston from 'winston';
import { exit } from "process";

let logger: winston.Logger;

export const initLogger = async () => {
	const logsDir = path.resolve('./logs');
	if (!fs.existsSync(logsDir)) {
		fs.mkdirSync(logsDir);
	}

	logger = winston.createLogger({
		level: "silly",
		format: winston.format.combine(
			winston.format.timestamp(),
			winston.format.printf(({ timestamp, level, message }) => {
				return `${timestamp} ${level}: ${message}`;
			})
		),

		transports: [
			new winston.transports.File({
				filename: path.join(logsDir, 'app.log'),
				level: 'info',
				maxsize: 15 * 1024 * 1024, // 15MB
				maxFiles: 10,
			}),
			new winston.transports.File({
				filename: path.join(logsDir, 'critical.log'),
				level: 'warn',
				maxsize: 15 * 1024 * 1024, // 15MB
				maxFiles: 10,
			}),
			new winston.transports.File({
				filename: path.join(logsDir, 'silly.log'),
				level: 'silly',
				maxsize: 15 * 1024 * 1024, // 15MB
				maxFiles: 10,
			}),
		]
	})

	logger.add(new winston.transports.Console({
		format: winston.format.combine(
			winston.format.colorize(),
			winston.format.simple(),
		),
		level: 'silly',
	}));

	// Add a flush method
	(logger as any).flush = async function () {
		// Wait for logs to be written, e.g.:
		return new Promise<void>(resolve => {
			this.on('finish', () => resolve());
			this.end();
		});
	};

	logger.info("Logger initialized.");

	return logger;
}

export const getLogger = () => {
	if (!logger) {
		throw new Error("Logger not initialized. Call initLogger() first.");
	}

	return logger;
}
