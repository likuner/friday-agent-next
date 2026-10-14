import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/db';
import { users } from '@/db/schema';
import { verifyCaptcha } from '@/lib/auth/captcha';
import { publicUser } from '@/lib/auth/guard';
import { createToken } from '@/lib/auth/jwt';
import { verifyPassword } from '@/lib/auth/password';
import { HttpError, handleError, readJson } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  captcha: z.string().min(4).max(8),
  captcha_token: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, '参数不合法');
    const { username, password, captcha, captcha_token } = parsed.data;

    if (!verifyCaptcha(captcha, captcha_token)) throw new HttpError(400, '验证码错误或已过期');

    const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new HttpError(401, '用户名或密码错误');
    }

    return NextResponse.json({ access_token: await createToken(user.id), token_type: 'bearer', user: publicUser(user) });
  } catch (error) {
    return handleError(error);
  }
}
