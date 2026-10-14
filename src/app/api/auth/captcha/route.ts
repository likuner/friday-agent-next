import { NextResponse } from 'next/server';

import { createCaptcha } from '@/lib/auth/captcha';
import { handleError } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(createCaptcha());
  } catch (error) {
    return handleError(error);
  }
}
