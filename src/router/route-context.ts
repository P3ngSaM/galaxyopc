import type { IncomingMessage, ServerResponse } from "node:http";
import type { Db } from "../db.js";

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  db: Db;
  pathname: string;
  method: string;
}
