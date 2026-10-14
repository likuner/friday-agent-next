import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { users, type User } from '@/db/schema';
import { verifyToken } from '@/lib/auth/jwt';
import { HttpError } from '@/lib/http';

// 对应原 backend/app/auth.py 的 current_user 依赖：解析 Bearer token 并加载用户。
// 各业务路由（route handler）开头调用，失败统一 401。
export async function requireUser(request: Request): Promise<User> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) throw new HttpError(401, '请先登录');
  const token = header.slice(7).trim();
  let userId: string;
  try {
    userId = await verifyToken(token);
  } catch {
    throw new HttpError(401, '登录状态已失效');
  }
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new HttpError(401, '用户不存在');
  return user;
}

export function publicUser(user: User) {
  return { id: user.id, username: user.username };
}
