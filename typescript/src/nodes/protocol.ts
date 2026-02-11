/**
 * Mobile Node Protocol
 * Protocol for iOS/Android app communication via Canvas
 */

import { EventEmitter } from 'events';

export interface MobileNode {
  id: string;
  name: string;
  platform: 'ios' | 'android';
  version: string;
  capabilities: NodeCapability[];
  status: 'connected' | 'disconnected' | 'pairing';
  lastSeen: string;
  metadata: Record<string, unknown>;
}

export type NodeCapability =
  | 'camera'
  | 'microphone'
  | 'location'
  | 'notifications'
  | 'contacts'
  | 'calendar'
  | 'files'
  | 'clipboard'
  | 'screen'
  | 'sensors';

export interface NodeMessage {
  id: string;
  type: NodeMessageType;
  nodeId: string;
  payload: unknown;
  timestamp: string;
}

export type NodeMessageType =
  | 'handshake'
  | 'capabilities'
  | 'request'
  | 'response'
  | 'event'
  | 'error'
  | 'ping'
  | 'pong';

export interface NodeRequest {
  id: string;
  action: NodeAction;
  params?: Record<string, unknown>;
}

export type NodeAction =
  | 'camera.capture'
  | 'camera.stream'
  | 'location.get'
  | 'location.watch'
  | 'microphone.record'
  | 'notifications.send'
  | 'notifications.list'
  | 'contacts.list'
  | 'contacts.search'
  | 'calendar.list'
  | 'calendar.create'
  | 'files.list'
  | 'files.read'
  | 'files.write'
  | 'clipboard.read'
  | 'clipboard.write'
  | 'screen.capture'
  | 'sensors.read';

export interface NodeResponse {
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface NodeEvent {
  type: string;
  data: unknown;
}

export class MobileNodeProtocol extends EventEmitter {
  private nodes = new Map<string, MobileNode>();
  private pendingRequests = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }
  >();
  private requestTimeout: number;

  constructor(options?: { requestTimeout?: number }) {
    super();
    this.requestTimeout = options?.requestTimeout ?? 30000;
  }

  /**
   * Register a new node
   */
  registerNode(
    id: string,
    name: string,
    platform: 'ios' | 'android',
    version: string
  ): MobileNode {
    const node: MobileNode = {
      id,
      name,
      platform,
      version,
      capabilities: [],
      status: 'pairing',
      lastSeen: new Date().toISOString(),
      metadata: {},
    };

    this.nodes.set(id, node);
    return node;
  }

  /**
   * Handle incoming message from node
   */
  handleMessage(message: NodeMessage): void {
    const node = this.nodes.get(message.nodeId);

    switch (message.type) {
      case 'handshake':
        this.handleHandshake(message);
        break;

      case 'capabilities':
        this.handleCapabilities(message);
        break;

      case 'response':
        this.handleResponse(message);
        break;

      case 'event':
        this.handleEvent(message);
        break;

      case 'pong':
        if (node) {
          node.lastSeen = new Date().toISOString();
        }
        break;

      case 'error':
        this.emit('error', { nodeId: message.nodeId, error: message.payload });
        break;
    }

    // Update last seen
    if (node) {
      node.lastSeen = message.timestamp;
    }
  }

  /**
   * Handle handshake from node
   */
  private handleHandshake(message: NodeMessage): void {
    const node = this.nodes.get(message.nodeId);
    if (!node) return;

    const payload = message.payload as {
      name?: string;
      platform?: 'ios' | 'android';
      version?: string;
    };

    if (payload.name) node.name = payload.name;
    if (payload.platform) node.platform = payload.platform;
    if (payload.version) node.version = payload.version;

    node.status = 'connected';

    this.emit('node:connected', node);
  }

  /**
   * Handle capabilities update from node
   */
  private handleCapabilities(message: NodeMessage): void {
    const node = this.nodes.get(message.nodeId);
    if (!node) return;

    node.capabilities = message.payload as NodeCapability[];

    this.emit('node:capabilities', { nodeId: message.nodeId, capabilities: node.capabilities });
  }

  /**
   * Handle response from node
   */
  private handleResponse(message: NodeMessage): void {
    const response = message.payload as NodeResponse;
    const pending = this.pendingRequests.get(response.requestId);

    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.requestId);

    if (response.success) {
      pending.resolve(response.data);
    } else {
      pending.reject(new Error(response.error ?? 'Request failed'));
    }
  }

  /**
   * Handle event from node
   */
  private handleEvent(message: NodeMessage): void {
    const event = message.payload as NodeEvent;
    this.emit('node:event', {
      nodeId: message.nodeId,
      type: event.type,
      data: event.data,
    });
  }

  /**
   * Send request to node
   */
  async sendRequest(nodeId: string, action: NodeAction, params?: Record<string, unknown>): Promise<unknown> {
    const node = this.nodes.get(nodeId);
    if (!node || node.status !== 'connected') {
      throw new Error('Node not connected');
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const request: NodeRequest = {
      id: requestId,
      action,
      params,
    };

    const message: NodeMessage = {
      id: `msg_${Date.now()}`,
      type: 'request',
      nodeId,
      payload: request,
      timestamp: new Date().toISOString(),
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Request timeout'));
      }, this.requestTimeout);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      this.emit('send', message);
    });
  }

  /**
   * Send ping to node
   */
  ping(nodeId: string): void {
    const message: NodeMessage = {
      id: `msg_${Date.now()}`,
      type: 'ping',
      nodeId,
      payload: null,
      timestamp: new Date().toISOString(),
    };

    this.emit('send', message);
  }

  /**
   * Get node by ID
   */
  getNode(nodeId: string): MobileNode | undefined {
    return this.nodes.get(nodeId);
  }

  /**
   * Get all nodes
   */
  getNodes(): MobileNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Get connected nodes
   */
  getConnectedNodes(): MobileNode[] {
    return this.getNodes().filter((n) => n.status === 'connected');
  }

  /**
   * Disconnect node
   */
  disconnectNode(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) return false;

    node.status = 'disconnected';
    this.emit('node:disconnected', node);

    return true;
  }

  /**
   * Remove node
   */
  removeNode(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    if (node) {
      this.emit('node:removed', node);
    }
    return this.nodes.delete(nodeId);
  }

  /**
   * Check if node has capability
   */
  hasCapability(nodeId: string, capability: NodeCapability): boolean {
    const node = this.nodes.get(nodeId);
    return node?.capabilities.includes(capability) ?? false;
  }

  // Convenience methods for common actions

  /**
   * Capture photo from node camera
   */
  async capturePhoto(
    nodeId: string,
    options?: { camera?: 'front' | 'back'; quality?: number }
  ): Promise<string> {
    return this.sendRequest(nodeId, 'camera.capture', options) as Promise<string>;
  }

  /**
   * Get current location from node
   */
  async getLocation(
    nodeId: string
  ): Promise<{ latitude: number; longitude: number; accuracy?: number }> {
    return this.sendRequest(nodeId, 'location.get') as Promise<{
      latitude: number;
      longitude: number;
      accuracy?: number;
    }>;
  }

  /**
   * Send notification via node
   */
  async sendNotification(
    nodeId: string,
    title: string,
    body: string,
    options?: Record<string, unknown>
  ): Promise<void> {
    await this.sendRequest(nodeId, 'notifications.send', { title, body, ...options });
  }

  /**
   * Read clipboard from node
   */
  async readClipboard(nodeId: string): Promise<string> {
    return this.sendRequest(nodeId, 'clipboard.read') as Promise<string>;
  }

  /**
   * Write to clipboard on node
   */
  async writeClipboard(nodeId: string, text: string): Promise<void> {
    await this.sendRequest(nodeId, 'clipboard.write', { text });
  }

  /**
   * Capture screen from node
   */
  async captureScreen(nodeId: string): Promise<string> {
    return this.sendRequest(nodeId, 'screen.capture') as Promise<string>;
  }
}

export function createMobileNodeProtocol(options?: { requestTimeout?: number }): MobileNodeProtocol {
  return new MobileNodeProtocol(options);
}
