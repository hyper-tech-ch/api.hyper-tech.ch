import { RouteHandler } from "exports/route";
import { NextFunction, Request, Response } from "express";
import axios from 'axios';

const UpdateInterval: number = 1 // hours
const ADDON_ID: string = "{2444bfd2-8a5d-4f70-96c3-65e9b889dc88}";

let cache = {
	lastUpdate: 0,
	users: 0,
}

async function getAddonUsers(): Promise<number> {
	try {
		const url: string = `https://addons.mozilla.org/api/v5/addons/addon/${ADDON_ID}/`;
		const response = await axios.get(url);

		console.log(response);

		if (response.status === 200) {
			return response.data.average_daily_users;
		} else {
			throw new Error(`Failed to fetch data: ${response.status}`);
		}
	} catch (error) {
		console.error('Error fetching addon users:', error);
		throw error;
	}
}

export default {
	Method: "get",
	Path: "/badges/v1/firefox-addon",
	Priority: 0,

	AuthorizationGroup: null,

	OnRequest: async function (req: Request, res: Response, next: NextFunction) {
		let lastUpdate = new Date().getTime() - cache.lastUpdate

		if (lastUpdate > UpdateInterval * 60 * 60) {
			cache.users = await getAddonUsers();
			cache.lastUpdate = new Date().getTime();
		}

		res.redirect( `https://img.shields.io/badge/weekly_downloads-${cache.users}-green` )
	}
} satisfies RouteHandler