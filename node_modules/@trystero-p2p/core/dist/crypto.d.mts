//#region src/crypto.d.ts
declare const hashWith: (algorithm: string, str: string) => Promise<Uint8Array>;
declare const sha1: (str: string) => Promise<string>;
//#endregion
export { hashWith, sha1 };
//# sourceMappingURL=crypto.d.mts.map