// REST 錯誤：HTTP 狀態碼 + ApiError（code 穩定可比對，message 給人看）。
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
    /** 放進 ApiError.detail 給程式讀（例如 zone_not_empty 的團隊數、session 數）。 */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
