declare global {
	namespace NodeJS {
		interface ProcessEnv {
			NODE_ENV: 'development' | 'production' | 'test';
			PORT: string;

			MONGO_URI: string;
			MONGO_DB_NAME: string;

			STRIPE_SECRET_KEY: string;
			STRIPE_PUBLIC_KEY: string;
			STRIPE_SIGNING_SECRET: string;

			MAIL_USER: string;
			MAIL_PASS: string;
			MAIL_HOST: string;
			MAIL_PORT: string;
		}
	}
}

export { };
