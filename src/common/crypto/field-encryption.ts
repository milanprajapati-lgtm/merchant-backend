import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { ValueTransformer } from 'typeorm';

/**
 * Field-level encryption (AES-256-GCM) for PII columns.
 *
 * Stored format: `v1:<iv>:<authTag>:<ciphertext>` (base64 parts). The version prefix lets a
 * future key rotation re-encrypt rows lazily. Encrypted columns cannot be filtered or sorted
 * in SQL; that is an accepted trade-off for owner identity / contact data.
 */
const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

function loadKey(): Buffer {
  const hex = process.env.FIELD_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('FIELD_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptField(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, loadKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptField(payload: string): string {
  const [version, iv, tag, ciphertext] = payload.split(':');
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error('Unsupported encrypted field format');
  }
  const decipher = createDecipheriv(ALGORITHM, loadKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

export const encryptedColumn: ValueTransformer = {
  to: (value?: string | null) => (value == null ? value : encryptField(value)),
  from: (value?: string | null) => (value == null ? value : decryptField(value)),
};
