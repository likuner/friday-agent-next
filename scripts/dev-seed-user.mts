// 开发辅助：直接创建/复用一个本地测试用户并打印 JWT（绕过验证码，便于 curl 调试）。
// 仅限本机开发使用：npx tsx scripts/dev-seed-user.mts [username]
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { hash } from '@node-rs/argon2';

import { db } from '../src/db';
import { users } from '../src/db/schema';
import { createToken } from '../src/lib/auth/jwt';

const username = process.argv[2] || 'devtester';
const existing = await db.select().from(users).where(eq(users.username, username)).limit(1);
let userId = existing[0]?.id;
if (!userId) {
  const [user] = await db
    .insert(users)
    .values({ username, passwordHash: await hash('test123456') })
    .returning();
  userId = user.id;
}
console.log(JSON.stringify({ user_id: userId, token: await createToken(userId) }));
process.exit(0);
