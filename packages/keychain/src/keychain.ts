export interface KeychainEntry {
  providerId: string;
  key: string;
}

export interface Keychain {
  get(providerId: string): Promise<string | null>;
  set(providerId: string, key: string): Promise<void>;
  delete(providerId: string): Promise<void>;
  list(): Promise<string[]>;
}
