import { NextFunction, Request, Response } from "express";

export type RouteHandler = {
	Method: "get" | "head" | "post" | "put" | "delete" | "connect" | "options" | "trace" | "patch" | "use";
	Path: string;
	Priority: number;

	AuthorizationGroup: string,

	OnRequest: (req: Request, res: Response, next: NextFunction) => void;
};