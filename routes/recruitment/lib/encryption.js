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
  
  return Buffer.from(`ENC:${iv.toString('hex')}:${authTag}:${encrypted}`).toString('base64');
};

export const decryptPassword = (payload) => {
  if (!payload || typeof payload !== 'string') {
    return payload;
  }
  
  try {
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    const parts = decoded.split(':');
    
    let ivHex, authTagHex, encryptedHex;
    
    if (parts[0] === 'ENC' && parts.length === 4) {
      [, ivHex, authTagHex, encryptedHex] = parts;
    } else if (parts.length === 3 && parts[0].length === 32 && parts[1].length === 32) {
      // Backward-compatibility for legacy format without ENC: prefix
      [ivHex, authTagHex, encryptedHex] = parts;
    } else {
      // Plain text password
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
    // If decryption fails, payload might be stored in plain text
    return payload;
  }
};
