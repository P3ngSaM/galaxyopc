import jwt from "jsonwebtoken";

export interface TokenPayload {
  userId: string;
  phone: string;
  role: string;
}

let _secret = "opc-default-jwt-secret";

export function setJwtSecret(secret: string): void {
  _secret = secret;
}

export function signToken(payload: TokenPayload, expiresIn = "7d"): string {
  return jwt.sign(payload, _secret, { expiresIn } as any);
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, _secret) as TokenPayload;
}
