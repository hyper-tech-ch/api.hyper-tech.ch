import { NextFunction, Request, Response } from "express";

export type RouteHandler = {
	Method: "get" | "post";
	Path: string;
	Priority: number;

	OnRequest: (req: Request, res: Response, next: NextFunction) => void;
};