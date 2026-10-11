declare module "tmi.js" {
  export type ClientOptions = {
    identity?: { username?: string; password?: string };
    channels?: string[];
    connection?: { reconnect?: boolean; secure?: boolean };
  };

  export class Client {
    constructor(options: ClientOptions);
    on(event: "message", callback: (channel: string, tags: Record<string, string | undefined>, message: string, self: boolean) => void | Promise<void>): void;
    connect(): Promise<[string, number]>;
    getChannels(): string[];
    join(channel: string): Promise<[string]>;
  }

  const tmi: { Client: typeof Client };
  export default tmi;
}
