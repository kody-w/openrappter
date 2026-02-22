/**
 * Device Pairing
 * Manages device identity, trust, and token management
 */

import { randomBytes, createHash, generateKeyPairSync } from 'crypto';

export interface Device {
  id: string;
  name: string;
  type: 'cli' | 'web' | 'mobile' | 'gateway' | 'remote';
  publicKey?: string;
  fingerprint?: string;
  trusted: boolean;
  createdAt: string;
  lastSeen: string;
  metadata?: Record<string, unknown>;
}

export interface PairingRequest {
  id: string;
  deviceId: string;
  deviceName: string;
  deviceType: Device['type'];
  challenge: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  approvedBy?: string;
  approvedAt?: string;
}

export interface DeviceToken {
  token: string;
  deviceId: string;
  createdAt: string;
  expiresAt?: string;
  lastUsed?: string;
  scopes?: string[];
}

const TOKEN_EXPIRY_DAYS = 30;
const PAIRING_EXPIRY_MINUTES = 5;

export class DevicePairingManager {
  private devices = new Map<string, Device>();
  private tokens = new Map<string, DeviceToken>();
  private pairingRequests = new Map<string, PairingRequest>();

  /**
   * Generate a new device ID
   */
  generateDeviceId(): string {
    return `device_${randomBytes(12).toString('hex')}`;
  }

  /**
   * Register a new device
   */
  registerDevice(
    id: string,
    name: string,
    type: Device['type'],
    trusted = false
  ): Device {
    const device: Device = {
      id,
      name,
      type,
      trusted,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };

    this.devices.set(id, device);
    return device;
  }

  /**
   * Register device with key pair
   */
  registerDeviceWithKeys(
    name: string,
    type: Device['type']
  ): { device: Device; privateKey: string } {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const fingerprint = createHash('sha256')
      .update(publicKey)
      .digest('hex')
      .slice(0, 16);

    const id = `device_${fingerprint}`;

    const device: Device = {
      id,
      name,
      type,
      publicKey,
      fingerprint,
      trusted: false,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };

    this.devices.set(id, device);
    return { device, privateKey };
  }

  /**
   * Get a device
   */
  getDevice(id: string): Device | undefined {
    return this.devices.get(id);
  }

  /**
   * Update device last seen
   */
  touchDevice(id: string): void {
    const device = this.devices.get(id);
    if (device) {
      device.lastSeen = new Date().toISOString();
    }
  }

  /**
   * Trust a device
   */
  trustDevice(id: string): boolean {
    const device = this.devices.get(id);
    if (!device) return false;

    device.trusted = true;
    return true;
  }

  /**
   * Revoke device trust
   */
  untrustDevice(id: string): boolean {
    const device = this.devices.get(id);
    if (!device) return false;

    device.trusted = false;

    // Revoke all tokens for this device
    for (const [tokenId, token] of this.tokens) {
      if (token.deviceId === id) {
        this.tokens.delete(tokenId);
      }
    }

    return true;
  }

  /**
   * Delete a device
   */
  deleteDevice(id: string): boolean {
    // Revoke tokens first
    this.untrustDevice(id);

    // Delete pending pairing requests
    for (const [reqId, req] of this.pairingRequests) {
      if (req.deviceId === id) {
        this.pairingRequests.delete(reqId);
      }
    }

    return this.devices.delete(id);
  }

  /**
   * Get all devices
   */
  getDevices(): Device[] {
    return Array.from(this.devices.values());
  }

  /**
   * Get trusted devices
   */
  getTrustedDevices(): Device[] {
    return this.getDevices().filter((d) => d.trusted);
  }

  /**
   * Create a pairing request
   */
  createPairingRequest(
    deviceId: string,
    deviceName: string,
    deviceType: Device['type']
  ): PairingRequest {
    const request: PairingRequest = {
      id: `pair_${randomBytes(8).toString('hex')}`,
      deviceId,
      deviceName,
      deviceType,
      challenge: randomBytes(32).toString('hex'),
      expiresAt: new Date(
        Date.now() + PAIRING_EXPIRY_MINUTES * 60 * 1000
      ).toISOString(),
      status: 'pending',
    };

    this.pairingRequests.set(request.id, request);
    return request;
  }

  /**
   * Get pairing request
   */
  getPairingRequest(id: string): PairingRequest | undefined {
    return this.pairingRequests.get(id);
  }

  /**
   * Get pending pairing requests
   */
  getPendingRequests(): PairingRequest[] {
    const now = new Date().toISOString();
    return Array.from(this.pairingRequests.values()).filter(
      (r) => r.status === 'pending' && r.expiresAt > now
    );
  }

  /**
   * Approve a pairing request
   */
  approvePairingRequest(
    requestId: string,
    approvedBy: string
  ): { success: boolean; token?: string; error?: string } {
    const request = this.pairingRequests.get(requestId);
    if (!request) {
      return { success: false, error: 'Request not found' };
    }

    if (request.status !== 'pending') {
      return { success: false, error: `Request already ${request.status}` };
    }

    if (new Date(request.expiresAt) < new Date()) {
      request.status = 'expired';
      return { success: false, error: 'Request expired' };
    }

    // Update request
    request.status = 'approved';
    request.approvedBy = approvedBy;
    request.approvedAt = new Date().toISOString();

    // Register and trust device
    const device = this.registerDevice(
      request.deviceId,
      request.deviceName,
      request.deviceType,
      true
    );

    // Generate token
    const token = this.generateToken(device.id);

    return { success: true, token: token.token };
  }

  /**
   * Reject a pairing request
   */
  rejectPairingRequest(requestId: string): boolean {
    const request = this.pairingRequests.get(requestId);
    if (!request || request.status !== 'pending') {
      return false;
    }

    request.status = 'rejected';
    return true;
  }

  /**
   * Generate a device token
   */
  generateToken(deviceId: string, scopes?: string[]): DeviceToken {
    const device = this.devices.get(deviceId);
    if (!device || !device.trusted) {
      throw new Error('Device not found or not trusted');
    }

    const tokenValue = randomBytes(32).toString('hex');
    const token: DeviceToken = {
      token: tokenValue,
      deviceId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      scopes,
    };

    this.tokens.set(tokenValue, token);
    return token;
  }

  /**
   * Validate a token
   */
  validateToken(tokenValue: string): { valid: boolean; device?: Device; error?: string } {
    const token = this.tokens.get(tokenValue);
    if (!token) {
      return { valid: false, error: 'Token not found' };
    }

    if (token.expiresAt && new Date(token.expiresAt) < new Date()) {
      this.tokens.delete(tokenValue);
      return { valid: false, error: 'Token expired' };
    }

    const device = this.devices.get(token.deviceId);
    if (!device) {
      this.tokens.delete(tokenValue);
      return { valid: false, error: 'Device not found' };
    }

    if (!device.trusted) {
      return { valid: false, error: 'Device not trusted' };
    }

    // Update last used
    token.lastUsed = new Date().toISOString();
    this.touchDevice(device.id);

    return { valid: true, device };
  }

  /**
   * Revoke a token
   */
  revokeToken(tokenValue: string): boolean {
    return this.tokens.delete(tokenValue);
  }

  /**
   * Rotate token (generate new, revoke old)
   */
  rotateToken(oldToken: string): DeviceToken | null {
    const existing = this.tokens.get(oldToken);
    if (!existing) return null;

    const newToken = this.generateToken(existing.deviceId, existing.scopes);
    this.tokens.delete(oldToken);

    return newToken;
  }

  /**
   * Get tokens for a device
   */
  getDeviceTokens(deviceId: string): DeviceToken[] {
    return Array.from(this.tokens.values()).filter((t) => t.deviceId === deviceId);
  }

  /**
   * Clean up expired tokens and requests
   */
  cleanup(): { expiredTokens: number; expiredRequests: number } {
    const now = new Date();
    let expiredTokens = 0;
    let expiredRequests = 0;

    for (const [id, token] of this.tokens) {
      if (token.expiresAt && new Date(token.expiresAt) < now) {
        this.tokens.delete(id);
        expiredTokens++;
      }
    }

    for (const [, request] of this.pairingRequests) {
      if (request.status === 'pending' && new Date(request.expiresAt) < now) {
        request.status = 'expired';
        expiredRequests++;
      }
    }

    return { expiredTokens, expiredRequests };
  }
}

export function createDevicePairingManager(): DevicePairingManager {
  return new DevicePairingManager();
}
