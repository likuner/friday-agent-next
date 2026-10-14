import { SignJWT, jwtVerify } from 'jose';

import { env } from '@/lib/env';

const secretKey = new TextEncoder().encode(env.jwtSecret);

export async function createToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${env.jwtExpireMinutes}m`)
    .sign(secretKey);
}

// 返回 sub（用户 id）；无效/过期抛 jose 的 JWTError，由调用方转 401
export async function verifyToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, secretKey, { algorithms: ['HS256'] });
  if (!payload.sub) throw new Error('token 缺少 sub');
  return payload.sub;
}
