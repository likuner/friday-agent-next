import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import svgCaptcha from 'svg-captcha';

import { env } from '@/lib/env';

const CAPTCHA_TTL_MS = 600_000;
// 答案字符集：去掉易混淆字符（i/l/o/0/1）
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

// 已核销的 nonce → 核销时间。
// 验证码本身是「无状态签名 token」：答案只以 HMAC 指纹的形式待在 token 里，服务端不保存答案，
// 因此 dev 热更新/重启、乃至多副本部署都不会让已经发出去的验证码失效（早先用进程内 Map 存答案，
// 改一个后端文件触发热更新就让屏幕上的码作废）。这张表只负责「一次性」重放保护：重启后清空，
// 最多允许同一 token 在 TTL 内被重放一次，对登录场景可以接受。
const consumed = new Map<string, number>();

// 域分离的 HMAC：签发 token 与「答案指纹」用不同前缀，避免同一密钥在两种用途间混淆
function hmac(domain: string, input: string): string {
  return createHmac('sha256', env.jwtSecret).update(`${domain}:${input}`).digest('base64url');
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const normalize = (value: string) => value.trim().toLowerCase();

function sweepConsumed(now: number): void {
  for (const [nonce, at] of consumed) {
    if (now - at >= CAPTCHA_TTL_MS) consumed.delete(nonce);
  }
}

export function createCaptcha(): { image: string; token: string } {
  // 未被核销的条目不会走 verify 的清理，签发时顺带清扫，防止匿名刷接口撑大内存
  const now = Date.now();
  sweepConsumed(now);

  // 验证码答案用 crypto 随机（Math.random 可预测）
  const answer = Array.from(randomBytes(4), (byte) => ALPHABET[byte % ALPHABET.length]).join('');
  // 关键：必须把 answer 交给渲染函数，让「图里画的字符」和「校验用的答案」是同一个字符串。
  // svg-captcha 的 `.create(options)` 会自己随机生成文字并只返回 {text, data}（它不管我们
  // 手里的 answer），早先这里取的是 .create(...).data，等于画的是另一串随机字符 → 图与答案
  // 毫不相干，任何输入都会被判为「验证码不正确」。
  // 该包 module.exports 就是底层 `createCaptcha(text, options)`（渲染指定文本），但官方
  // .d.ts 只声明了 named exports，故在此显式收窄类型后调用。
  const renderSvg = svgCaptcha as unknown as (text: string, options?: Record<string, unknown>) => string;
  const svg = renderSvg(answer, { noise: 3, color: true, background: '#f1f4ff' });

  // token = base64url(payload) + "." + HMAC(payload)。payload 里只放答案的 HMAC 指纹，不放答案：
  // 客户端就算把 base64 解开也读不到答案，而反向爆破指纹需要 JWT_SECRET。
  const payload = Buffer.from(
    JSON.stringify({ n: randomBytes(18).toString('base64url'), t: now, p: hmac('captcha-answer', normalize(answer)) }),
  ).toString('base64url');
  const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  return { image, token: `${payload}.${hmac('captcha-token', payload)}` };
}

export function verifyCaptcha(value: string, captchaToken: string): boolean {
  try {
    // payload 是 base64url，不含 "."，故用最后一个 "." 切分（签名同样是 base64url）
    const separator = captchaToken.lastIndexOf('.');
    if (separator <= 0) return false;
    const payload = captchaToken.slice(0, separator);
    const signature = captchaToken.slice(separator + 1);
    if (!equalSecret(hmac('captcha-token', payload), signature)) return false;

    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return false;
    const { n, t, p } = parsed as { n?: unknown; t?: unknown; p?: unknown };
    if (typeof n !== 'string' || typeof t !== 'number' || typeof p !== 'string') return false;

    const now = Date.now();
    // 过期，或签发时间在未来（时钟异常/伪造）都拒绝
    if (now - t >= CAPTCHA_TTL_MS || t > now + 60_000) return false;

    sweepConsumed(now);
    if (consumed.has(n)) return false;
    // 与原实现一致：这一次校验无论成败都核销该 nonce（前端失败后会自动换图）
    consumed.set(n, now);

    return equalSecret(p, hmac('captcha-answer', normalize(value)));
  } catch {
    return false;
  }
}
