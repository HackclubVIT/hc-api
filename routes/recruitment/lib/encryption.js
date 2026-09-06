import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const getEncryptionKey = () => {
  const secret = process.env.SMTP_ENCRYPTION_KEY || 'default_fallback_smtp_encryption_key_32_bytes!';
  return crypto.createHash('sha256').update(String(secret)).digest();
};

export const encryptPassword = (text) => {
  if (!text) return text;
  
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag().toString('hex');
  
  return Buffer.from(`${iv.toString('hex')}:${authTag}:${encrypted}`).toString('base64');
};

export const decryptPassword = (payload) => {
  if (!payload || !payload.includes('=')) {
    return payload;
  }
  
  try {
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    const [ivHex, authTagHex, encryptedHex] = decoded.split(':');
    
    if (!ivHex || !authTagHex || !encryptedHex) {
      return payload;
    }
    
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('[ENCRYPTION ERROR] Failed to decrypt password:', error);
    return '';
  }
};
