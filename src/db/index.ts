import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { env } from '@/lib/env';
import * as schema from './schema';

// dev 热重载下避免每编译一次就新建一个连接池
const globalForDb = globalThis as unknown as { pool?: pg.Pool };

const pool = globalForDb.pool ?? new pg.Pool({ connectionString: env.databaseUrl, max: 10 });
if (!globalForDb.pool) globalForDb.pool = pool;

export const db = drizzle(pool, { schema });
export { schema };
