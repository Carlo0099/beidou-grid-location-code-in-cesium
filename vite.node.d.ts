declare module 'node:fs' {
  export function existsSync(p: string): boolean;
  export function statSync(p: string): { isFile(): boolean };
  export function openSync(p: string, flags: string): number;
  export function readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  export function closeSync(fd: number): void;
  export function createReadStream(p: string): {
    pipe(dest: unknown): void;
  };
  const fsDefault: {
    existsSync: typeof existsSync;
    statSync: typeof statSync;
    openSync: typeof openSync;
    readSync: typeof readSync;
    closeSync: typeof closeSync;
    createReadStream: typeof createReadStream;
  };
  export default fsDefault;
}

declare module 'node:path' {
  export function resolve(...paths: string[]): string;
  export function join(...paths: string[]): string;
  export const sep: string;
  const pathDefault: {
    resolve: typeof resolve;
    join: typeof join;
    sep: typeof sep;
  };
  export default pathDefault;
}

declare module 'node:http' {
  export interface IncomingMessage {
    url?: string;
    method?: string;
    on(event: 'data', cb: (chunk: Uint8Array) => void): void;
    on(event: 'end', cb: () => void): void;
    on(event: 'error', cb: (err: unknown) => void): void;
  }
  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
  }
}

declare const process: {
  cwd(): string;
};
