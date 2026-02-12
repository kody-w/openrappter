export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  backoff?: 'exponential' | 'linear';
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelay = options?.baseDelay ?? 1000;
  const maxDelay = options?.maxDelay ?? 30000;
  const backoff = options?.backoff ?? 'exponential';

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === maxRetries) {
        break;
      }

      // Calculate delay with jitter
      let delay: number;
      if (backoff === 'exponential') {
        delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      } else {
        delay = Math.min(baseDelay * (attempt + 1), maxDelay);
      }

      // Add jitter (random 0 to baseDelay)
      const jitter = Math.random() * baseDelay;
      delay = Math.min(delay + jitter, maxDelay);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
