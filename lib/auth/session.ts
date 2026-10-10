import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { UserProfile } from '../types';
import { getDatabaseAdapter } from '../db';

export const SESSION_COOKIE_NAME = 'hackmate_session';
const SESSION_EXPIRY_DAYS = 7;

function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  const isProduction = process.env.NODE_ENV === 'production';
  const isDefaultOrWeak = !secret || secret === 'hackmate-default-dev-secret-change-in-production-1234567890' || secret.includes('change-in-production');

  if (isProduction && isDefaultOrWeak) {
    throw new Error('SECURITY VIOLATION: A robust AUTH_SECRET environment variable must be explicitly configured in production.');
  }

  return secret || 'hackmate-default-dev-secret-change-in-production-1234567890';
}

export function createSessionToken(userId: string): string {
  const expiresAt = Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  const payload = `${userId}:${expiresAt}`;
  const hmac = crypto.createHmac('sha256', getAuthSecret()).update(payload).digest('hex');
  const token = Buffer.from(`${payload}:${hmac}`).toString('base64url');
  return token;
}

export function verifySessionToken(token: string): string | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf-8');
    const parts = decoded.split(':');
    if (parts.length !== 3) return null;

    const [userId, expiresAtStr, receivedHmac] = parts;
    const expiresAt = parseInt(expiresAtStr, 10);
    if (isNaN(expiresAt) || Date.now() > expiresAt) {
      return null;
    }

    const payload = `${userId}:${expiresAtStr}`;
    const expectedHmac = crypto.createHmac('sha256', getAuthSecret()).update(payload).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(receivedHmac), Buffer.from(expectedHmac))) {
      return null;
    }

    return userId;
  } catch {
    return null;
  }
}

export async function getCurrentUserFromRequest(request: NextRequest | Request): Promise<UserProfile | null> {
  let token: string | null = null;

  // 1. Try Authorization header
  const authHeader = request.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }

  // 2. Try cookie
  if (!token) {
    const cookieHeader = request.headers.get('cookie') || '';
    const cookies = Object.fromEntries(
      cookieHeader.split(';').map((c) => {
        const [k, ...v] = c.trim().split('=');
        return [k, v.join('=')];
      })
    );
    token = cookies[SESSION_COOKIE_NAME] || null;
  }

  if (!token) return null;

  const userId = verifySessionToken(token);
  if (!userId) return null;

  const db = getDatabaseAdapter();
  return db.getUserById(userId);
}
