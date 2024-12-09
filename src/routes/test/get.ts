import { RouteHandler } from "exports/route";
import { NextFunction, Request, Response } from "express";

export default {
	Method: "get",
	Path: "/v1/test",
	Priority: 0,

	OnRequest: function (req: Request, res: Response, next: NextFunction) {
		res.send("I think the server works if you can read this message")
	}
} satisfies RouteHandler