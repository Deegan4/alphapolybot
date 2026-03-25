/**
 * Shared HTTP client with rate limiting and retry logic.
 * Uses native fetch (Node 18+).
 */

export interface HttpClientOptions {
  baseUrl: string;
  maxRequestsPerMinute?: number;
  timeout?: number;
  maxRetries?: number;
}

export class HttpClient {
  private baseUrl: string;
  private maxRpm: number;
  private timeout: number;
  private maxRetries: number;
  private requestTimestamps: number[] = [];

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.maxRpm = options.maxRequestsPerMinute ?? 60;
    this.timeout = options.timeout ?? 15000;
    this.maxRetries = options.maxRetries ?? 3;
  }

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    // Prune timestamps older than 1 minute
    this.requestTimestamps = this.requestTimestamps.filter(t => now - t < 60_000);

    if (this.requestTimestamps.length >= this.maxRpm) {
      const oldest = this.requestTimestamps[0];
      const waitMs = 60_000 - (now - oldest) + 50; // +50ms buffer
      await new Promise(r => setTimeout(r, waitMs));
    }

    this.requestTimestamps.push(Date.now());
  }

  async request<T>(
    method: string,
    path: string,
    options?: {
      headers?: Record<string, string>;
      body?: string;
      params?: Record<string, string>;
    },
  ): Promise<T> {
    await this.waitForRateLimit();

    let url = `${this.baseUrl}${path}`;
    if (options?.params) {
      const searchParams = new URLSearchParams(options.params);
      const separator = url.includes('?') ? '&' : '?';
      url += separator + searchParams.toString();
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const response = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...options?.headers,
          },
          body: options?.body,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          const error = new Error(`HTTP ${response.status}: ${errorText}`);
          (error as unknown as Record<string, unknown>).status = response.status;

          // Don't retry 4xx (client errors) except 429 (rate limit)
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            throw error;
          }

          lastError = error;

          // Retry on 429 or 5xx
          if (attempt < this.maxRetries) {
            const backoff = Math.min(1000 * 2 ** attempt, 10000);
            await new Promise(r => setTimeout(r, backoff));
            continue;
          }
          throw error;
        }

        const text = await response.text();
        if (!text) return {} as T;

        try {
          return JSON.parse(text) as T;
        } catch {
          return text as unknown as T;
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          lastError = new Error(`Request timed out after ${this.timeout}ms: ${method} ${path}`);
        } else if (error instanceof Error) {
          lastError = error;
        }

        // Don't retry non-retryable errors
        const errStatus = ((lastError ?? {}) as unknown as Record<string, unknown>).status as number | undefined;
        if (errStatus && errStatus >= 400 && errStatus < 500 && errStatus !== 429) {
          throw lastError;
        }

        if (attempt < this.maxRetries) {
          const backoff = Math.min(1000 * 2 ** attempt, 10000);
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }
      }
    }

    throw lastError || new Error(`Request failed: ${method} ${path}`);
  }

  async get<T>(path: string, options?: { headers?: Record<string, string>; params?: Record<string, string> }): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  async post<T>(path: string, data?: unknown, options?: { headers?: Record<string, string> }): Promise<T> {
    return this.request<T>('POST', path, {
      headers: options?.headers,
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  async del<T>(path: string, data?: unknown, options?: { headers?: Record<string, string> }): Promise<T> {
    return this.request<T>('DELETE', path, {
      headers: options?.headers,
      body: data ? JSON.stringify(data) : undefined,
    });
  }
}
