import { hash, verify } from '@node-rs/argon2';

// PHC 格式 argon2id，与原 pwdlib[argon2] 产出同族（各自校验自己签发的哈希即可）
export function hashPassword(value: string): Promise<string> {
  return hash(value);
}

export function verifyPassword(value: string, hashed: string): Promise<boolean> {
  return verify(hashed, value);
}
