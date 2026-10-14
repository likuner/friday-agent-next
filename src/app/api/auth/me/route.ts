import { NextResponse } from 'next/server';

import { publicUser, requireUser } from '@/lib/auth/guard';
import { handleError } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    return NextResponse.json(publicUser(user));
  } catch (error) {
    return handleError(error);
  }
}
