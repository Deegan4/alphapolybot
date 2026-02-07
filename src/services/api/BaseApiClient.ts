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
    
    if (error instanceof AxiosError) {
      // Retry on network errors
      if (!error.response) return true
      
      // Retry on specific status codes
      return this.retryableStatuses.includes(error.response.status)
    }
    
    return false
  }

  /**
   * Calculate retry delay with exponential backoff
   */
  private calculateRetryDelay(retryCount: number, error: unknown): number {
    let delay = this.retryDelay * Math.pow(2, retryCount)
    
    // If rate limited, use the retry-after header if available
    if (error instanceof AxiosError && error.response?.status === 429) {
      const retryAfter = error.response.headers['retry-after']
      if (retryAfter) {
        delay = parseInt(retryAfter, 10) * 1000
      }
    }
    
    // Add jitter to prevent thundering herd
    delay += Math.random() * 1000
    
    return Math.min(delay, 30000) // Cap at 30 seconds
  }

  /**
   * Handle errors
   */
  private handleError(error: AxiosError): Promise<never> {
    if (error.response) {
      // Server responded with error status
      const { status, data } = error.response
      console.error(`API Error ${status}:`, data)
      
      // Create a more descriptive error
      const message = (data as { message?: string })?.message || error.message
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
