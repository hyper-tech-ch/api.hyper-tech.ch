declare global {
	namespace NodeJS {
		interface ProcessEnv {
			NODE_ENV: 'development' | 'production' | 'test';
			PORT: string;

			MONGO_URI: string;
			MONGO_DB: string;

			STRIPE_SECRET_KEY: string;
			STRIPE_PUBLIC_KEY: string;
			STRIPE_SIGNING_SECRET: string;
			STRIPE_MOVIE_PRODUCT_ID: string;

			SEND_MAIL: "yes" | "no";
			MAIL_USER: string;
			MAIL_PASS: string;
			MAIL_HOST: string;
			MAIL_PORT: string;
		}
	}
}

export { };
