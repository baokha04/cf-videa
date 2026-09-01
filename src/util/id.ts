/** UUID v4 từ WebCrypto — có sẵn trong workerd, không cần thư viện. */
export function newId(): string {
  return crypto.randomUUID();
}

export function now(): number {
  return Date.now();
}
