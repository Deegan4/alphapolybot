import axios, { AxiosInstance, AxiosError, AxiosRequestConfig } from 'axios'

/**
 * Rate limiter using token bucket algorithm
 */
class RateLimiter {
  private tokens: number
  private lastRefill: number
  private readonly maxTokens: number
  private readonly refillRate: number // tokens per second

  constructor(maxTokens: number, refillRate: number) {
    this.maxTokens = maxTokens
    this.tokens = maxTokens
    this.lastRefill = Date.now()
    this.refillRate = refillRate
  }

  async acquire(cost = 1): Promise<void> {
    this.refill()
    
    if (this.tokens < cost) {
      const waitTime = ((cost - this.tokens) / this.refillRate) * 1000
      await new Promise(resolve => setTimeout(resolve, waitTime))
      this.refill()
    }
    
    this.tokens -= cost
  }

  getStatus(): { tokensRemaining: number; maxTokens: number } {
    this.refill()
    return { tokensRemaining: Math.floor(this.tokens), maxTokens: this.maxTokens }
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate)
    this.lastRefill = now
  }
}

/**
 * Base API client with rate limiting, retry logic, and error handling
 */
export class BaseApiClient {
  protected client: AxiosInstance
  protected rateLimiter: RateLimiter
  protected maxRetries: number
  protected retryDelay: number
  protected retryableStatuses: number[]

  constructor(
    baseURL: string,
    options: {
      maxRequestsPerMinute?: number
      maxRetries?: number
      retryDelay?: number
      timeout?: number
      headers?: Record<string, string>
    } = {}
  ) {
    const {
      maxRequestsPerMinute = 60,
      maxRetries = 3,
      retryDelay = 1000,
      timeout = 10000,
      headers = {},
    } = options

    this.client = axios.create({
      baseURL,
      timeout,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    })

    this.rateLimiter = new RateLimiter(maxRequestsPerMinute, maxRequestsPerMinute / 60)
    this.maxRetries = maxRetries
    this.retryDelay = retryDelay
    this.retryableStatuses = [429, 500, 502, 503, 504]

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      response => response,
      error => this.handleError(error)
    )
  }

  /**
   * Make a GET request with rate limiting and retry
   */
  protected async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return this.requestWithRetry<T>('get', url, undefined, config)
  }

  /**
   * Make a POST request with rate limiting and retry
   */
  protected async post<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return this.requestWithRetry<T>('post', url, data, config)
  }

  /**
   * Make a PUT request with rate limiting and retry
   */
  protected async put<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return this.requestWithRetry<T>('put', url, data, config)
  }

  /**
   * Make a DELETE request with rate limiting and retry
   */
  protected async delete<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return this.requestWithRetry<T>('delete', url, undefined, config)
  }

  /**
   * Request with retry logic
   */
  private async requestWithRetry<T>(
    method: 'get' | 'post' | 'put' | 'delete',
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
    retryCount = 0
  ): Promise<T> {
    await this.rateLimiter.acquire()

    try {
      let response
      switch (method) {
        case 'get':
          response = await this.client.get<T>(url, config)
          break
        case 'post':
          response = await this.client.post<T>(url, data, config)
          break
        case 'put':
          response = await this.client.put<T>(url, data, config)
          break
        case 'delete':
          response = await this.client.delete<T>(url, config)
          break
      }
      return response.data
    } catch (error) {
      if (this.shouldRetry(error, retryCount)) {
        const delay = this.calculateRetryDelay(retryCount, error)
        console.warn(`Request failed, retrying in ${delay}ms (attempt ${retryCount + 1}/${this.maxRetries})`)
        await new Promise(resolve => setTimeout(resolve, delay))
        return this.requestWithRetry<T>(method, url, data, config, retryCount + 1)
      }
      throw error
    }
  }

  /**
   * Determine if a request should be retried
   */
  private shouldRetry(error: unknown, retryCount: number): boolean {
    if (retryCount >= this.maxRetries) return false

    // handleError interceptor transforms AxiosError → plain Error with .status
    const status = (error as { status?: number }).status

    if (status) {
      // Never retry auth failures — they are structural, not transient
      if (status === 401 || status === 403) return false
      return this.retryableStatuses.includes(status)
    }

    // Network errors (no response/status) are retryable
    if (error instanceof Error) return true

    return false
  }

  /**
   * Calculate retry delay with exponential backoff
   */
  private calculateRetryDelay(retryCount: number, error: unknown): number {
    // Respect Retry-After header on 429 responses
    const retryAfter = this.parseRetryAfter(error)
    if (retryAfter > 0) return Math.min(retryAfter, 60000)

    let delay = this.retryDelay * Math.pow(2, retryCount)

    // Add jitter to prevent thundering herd
    delay += Math.random() * 1000

    return Math.min(delay, 30000) // Cap at 30 seconds
  }

  private parseRetryAfter(error: unknown): number {
    const axiosErr = error as { config?: { headers?: Record<string, string> }; response?: { headers?: Record<string, string> } }
    const header = axiosErr?.response?.headers?.['retry-after']
    if (!header) return 0

    // Retry-After can be seconds (integer) or HTTP-date
    const seconds = parseInt(header, 10)
    if (!isNaN(seconds) && seconds > 0) return seconds * 1000

    const date = new Date(header).getTime()
    if (!isNaN(date)) return Math.max(0, date - Date.now())

    return 0
  }

  /**
   * Handle errors
   */
  private handleError(error: AxiosError): Promise<never> {
    if (error.response) {
      // Server responded with error status
      const { status, data } = error.response

      if (status === 401) {
        console.error(
          `[API] 401 Unauthorized on ${error.config?.method?.toUpperCase()} ${error.config?.url}. ` +
          `POLY_ADDRESS likely does not match the API key's signer, or credentials are revoked/expired. ` +
          `Fix: Settings → API Keys → "Derive from Wallet" to generate matching credentials.`,
        )
      } else if (status === 402) {
        // Payment required / credits exhausted — not a bug, suppress noisy logging.
        // Callers already handle this gracefully (circuit breakers, empty enrichment, etc.)
        console.debug(`API 402 (credits exhausted): ${error.config?.url}`)
      } else if (status === 403) {
        // Cloudflare WAF block or auth rejection — log URL only, not the full HTML page
        console.warn(`API 403 Forbidden: ${error.config?.method?.toUpperCase()} ${error.config?.baseURL}${error.config?.url}`)
      } else {
        console.error(`API Error ${status}:`, typeof data === 'string' && data.length > 500 ? data.slice(0, 200) + '...' : data)
      }

      // Create a more descriptive error
      // Polymarket CLOB returns { error: "..." }, not { message: "..." }
      const dataObj = data as { message?: string; error?: string; errorMsg?: string }
      const message = dataObj?.error || dataObj?.message || dataObj?.errorMsg || error.message
      const apiError = new Error(`API Error (${status}): ${message}`)
      ;(apiError as Error & { status: number }).status = status
      ;(apiError as Error & { data: unknown }).data = data
      
      return Promise.reject(apiError)
    } else if (error.request) {
      // Request made but no response received
      console.error('Network Error:', error.message)
      return Promise.reject(new Error(`Network Error: ${error.message}`))
    } else {
      // Something else happened
      console.error('Error:', error.message)
      return Promise.reject(error)
    }
  }

  /**
   * Get current rate limiter status for monitoring.
   */
  getRateLimitStatus(): { tokensRemaining: number; maxTokens: number } {
    return this.rateLimiter.getStatus()
  }

  /**
   * Set authorization header
   */
  setAuthToken(token: string): void {
    this.client.defaults.headers.common['Authorization'] = `Bearer ${token}`
  }

  /**
   * Remove authorization header
   */
  clearAuthToken(): void {
    delete this.client.defaults.headers.common['Authorization']
  }
}
