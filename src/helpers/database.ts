import { MongoClient, Db } from "mongodb";

let isDatabaseConnected = false;
let client: MongoClient;
let db: Db;

export async function Connect() {
	client = new MongoClient(process.env.MONGO_URI);
	await client.connect();

	// Specify the database name here
	db = client.db(process.env.MONGO_DB_NAME);

	isDatabaseConnected = true;
}

export async function GetCollection(name: string) {
	if (!isDatabaseConnected) {
		await Connect();
	}

	// Access the collection from the database
	return db.collection(name);
}