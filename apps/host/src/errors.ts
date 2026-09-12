export class HostError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "HostError";
  }
}
export const unavailable = (service: string): never => {
  throw new HostError(-32011, `${service} is not configured.`);
};
export const notFound = (): never => { throw new HostError(-32004, "Item not found in this workspace."); };
export const conflict = (message: string): never => { throw new HostError(-32009, message); };
