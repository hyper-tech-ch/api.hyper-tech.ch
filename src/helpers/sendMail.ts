import nodemailer from 'nodemailer';
import path from 'path';
import { readDirRecursive } from './readDirRecursive';
import { readFile, readFileSync } from 'fs';
import { MailOptions } from 'nodemailer/lib/json-transport';

async function findEmailTemplate(htmlFileName: string): Promise<string | null> {
	const emailsDir = path.resolve(__dirname, '../../emails');
	const files = await readDirRecursive(emailsDir);

	const matchingFile = files.find(file => path.basename(file) === htmlFileName);
	return matchingFile || null;
}

export async function sendMail(to: string, subject: string, htmlFileName: string, variables?: Record<string, string> ): Promise<void> {
	// Send an email using the configured SMTP server
	console.log(`Sending email to ${to} with subject ${subject} and body ${htmlFileName}`);

	const htmlFilePath = await findEmailTemplate(htmlFileName);
	if (!htmlFilePath) {
		throw new Error(`Could not find email template ${htmlFileName}`);
	}

	////////////////////////

	let htmlContent = readFileSync(htmlFilePath, 'utf-8');

	// replace variables in the email template
	if (variables) {
		for (const [key, value] of Object.entries(variables)) {
			htmlContent = htmlContent.replace(new RegExp(`{{${key}}}`, 'g'), value);
			console.log(`Replacing all ${key} with ${value}`);
		}
	}

	////////////////////////

	const transporter = nodemailer.createTransport({
		host: process.env.MAIL_HOST,
		port: parseInt(process.env.MAIL_PORT),
		secure: false,
		auth: {
			user: process.env.MAIL_USER,
			pass: process.env.MAIL_PASS,
		},
	});

	const mailOptions: MailOptions = {
		from: `"Hyper Technologies" <${process.env.MAIL_USER}>`,
		to: to,
		subject: subject,
		replyTo: "joshua@hyper-tech.ch",
		html: htmlContent,
	};

	try {
		const info = await transporter.sendMail(mailOptions);
		console.log(`Email sent successfully: ${info.messageId}`);
	} catch (error: any) {
		console.error(`Failed to send email: ${error.message}`);
		throw error;
	}
}