/**
 * Secret Generator Module
 * Auto-generate passwords, keys, and tokens based on type
 */

import { randomBytes } from "crypto";
import type { SecretGenerator } from "./scanner";

/**
 * Character sets for password generation
 */
const CHARSET_LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
const CHARSET_UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CHARSET_NUMBERS = "0123456789";
const CHARSET_SPECIAL = "!@#$%^&*()-_=+[]{}|;:,.<>?";

/**
 * Generate a secure random password
 * 
 * @param length - Password length (default: 32)
 * @param options - Character set options
 * @returns Generated password
 */
export function generatePassword(
  length: number = 32,
  options: {
    lowercase?: boolean;
    uppercase?: boolean;
    numbers?: boolean;
    special?: boolean;
  } = {}
): string {
  const {
    lowercase = true,
    uppercase = true,
    numbers = true,
    special = true,
  } = options;
  
  let charset = "";
  if (lowercase) charset += CHARSET_LOWERCASE;
  if (uppercase) charset += CHARSET_UPPERCASE;
  if (numbers) charset += CHARSET_NUMBERS;
  if (special) charset += CHARSET_SPECIAL;
  
  if (charset.length === 0) {
    throw new Error("At least one character set must be enabled");
  }
  
  let password = "";
  const randomBytesBuffer = randomBytes(length);
  
  for (let i = 0; i < length; i++) {
    const randomIndex = randomBytesBuffer[i] % charset.length;
    password += charset[randomIndex];
  }
  
  return password;
}

/**
 * Generate a secure random key (alphanumeric only)
 * 
 * @param length - Key length (default: 32)
 * @returns Generated key
 */
export function generateKey(length: number = 32): string {
  return generatePassword(length, {
    lowercase: true,
    uppercase: true,
    numbers: true,
    special: false,
  });
}

/**
 * Generate a secure random token (hex format)
 * 
 * @param length - Token length in bytes (default: 32, produces 64 hex chars)
 * @returns Generated token in hex format
 */
export function generateToken(length: number = 32): string {
  return randomBytes(length).toString("hex");
}

/**
 * Generate a base64-encoded random string
 * 
 * @param length - Length in bytes (default: 32)
 * @returns Generated string in base64 format
 */
export function generateBase64String(length: number = 32): string {
  return randomBytes(length).toString("base64");
}

/**
 * Generate a URL-safe base64 string (no padding, URL-safe chars)
 * 
 * @param length - Length in bytes (default: 32)
 * @returns Generated URL-safe base64 string
 */
export function generateUrlSafeString(length: number = 32): string {
  return randomBytes(length)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Generate secret value based on generator configuration
 * 
 * @param generator - Generator configuration from values file
 * @returns Generated secret value
 */
export function generateSecretValue(generator: SecretGenerator): string {
  const length = generator.length || 32;
  
  switch (generator.type) {
    case "password":
      return generatePassword(length);
    
    case "key":
      return generateKey(length);
    
    case "token":
      return generateToken(length);
    
    case "string":
      return generateBase64String(length);
    
    default:
      throw new Error(`Unknown generator type: ${generator.type}`);
  }
}

/**
 * Validate password strength
 */
export function validatePasswordStrength(password: string): {
  valid: boolean;
  score: number; // 0-4
  feedback: string[];
} {
  const feedback: string[] = [];
  let score = 0;
  
  // Length check
  if (password.length >= 16) score++;
  if (password.length >= 24) score++;
  if (password.length >= 32) score++;
  
  // Character diversity
  if (/[a-z]/.test(password)) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) score++;
  
  // Feedback
  if (password.length < 16) {
    feedback.push("Password should be at least 16 characters");
  }
  
  if (!/[a-z]/.test(password)) {
    feedback.push("Add lowercase letters");
  }
  
  if (!/[A-Z]/.test(password)) {
    feedback.push("Add uppercase letters");
  }
  
  if (!/[0-9]/.test(password)) {
    feedback.push("Add numbers");
  }
  
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    feedback.push("Add special characters");
  }
  
  // Normalize score to 0-4
  const normalizedScore = Math.min(Math.floor(score / 2), 4);
  
  return {
    valid: normalizedScore >= 3,
    score: normalizedScore,
    feedback,
  };
}

/**
 * Get recommended length for secret type
 */
export function getRecommendedLength(type: SecretGenerator["type"]): number {
  switch (type) {
    case "password":
      return 32;
    case "key":
      return 32;
    case "token":
      return 32; // 64 hex chars
    case "string":
      return 24;
    default:
      return 32;
  }
}

/**
 * Format secret description for display
 */
export function formatSecretDescription(generator: SecretGenerator): string {
  const type = generator.type;
  const length = generator.length || getRecommendedLength(type);
  const description = generator.description || `${type} secret`;
  
  let format = "";
  switch (type) {
    case "password":
      format = "alphanumeric + special chars";
      break;
    case "key":
      format = "alphanumeric only";
      break;
    case "token":
      format = "hex encoded";
      break;
    case "string":
      format = "base64 encoded";
      break;
  }
  
  return `${description} (${type}, ${length} chars, ${format})`;
}
