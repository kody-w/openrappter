import { EventEmitter } from 'events';

export type SystemEvent =
  | 'agent:start'
  | 'agent:end'
  | 'message:in'
  | 'message:out'
  | 'error'
  | 'config:change'
  | 'gateway:start'
  | 'gateway:stop';

export class SystemEventBus extends EventEmitter {
  emit(event: SystemEvent, payload: unknown): boolean {
    return super.emit(event, payload);
  }

  on(event: SystemEvent, handler: (payload: unknown) => void): this {
    return super.on(event, handler);
  }

  once(event: SystemEvent, handler: (payload: unknown) => void): this {
    return super.once(event, handler);
  }

  off(event: SystemEvent, handler: (payload: unknown) => void): this {
    return super.off(event, handler);
  }
}

export const systemEvents = new SystemEventBus();
