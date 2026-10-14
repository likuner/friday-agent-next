import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/db';
import { users } from '@/db/schema';
import { verifyCaptcha } from '@/lib/auth/captcha';
import { createToken } from '@/lib/auth/jwt';
import { hashPassword } from '@/lib/auth/password';
import { publicUser } from '@/lib/auth/guard';
import { HttpError, handleError, readJson } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_\u4e00-\u9fff]+$/, '用户名仅支持字母、数字、下划线或中文'),
  password: z.string().min(6).max(72),
  captcha: z.string().min(4).max(8),
  captcha_token: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message || '参数不合法');
    const { username, password, captcha, captcha_token } = parsed.data;

    if (!verifyCaptcha(captcha, captcha_token)) throw new HttpError(400, '验证码错误或已过期');

    const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (exists) throw new HttpError(409, '用户名已存在');

    const [user] = await db
      .insert(users)
      .values({ username, passwordHash: await hashPassword(password) })
      .returning();

    return NextResponse.json({ access_token: await createToken(user.id), token_type: 'bearer', user: publicUser(user) });
  } catch (error) {
    return handleError(error);
  }
}
