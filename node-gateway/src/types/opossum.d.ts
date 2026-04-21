declare module 'opossum' {
  interface CircuitBreakerOptions {
    timeout?: number;
    errorThresholdPercentage?: number;
    resetTimeout?: number;
    volumeThreshold?: number;
    rollingCountTimeout?: number;
    rollingCountBuckets?: number;
  }

  class CircuitBreaker<TArgs extends unknown[] = unknown[], TReturn = unknown> {
    constructor(action: (...args: TArgs) => Promise<TReturn>, options?: CircuitBreakerOptions);
    fire(...args: TArgs): Promise<TReturn>;
    fallback(fn: (...args: TArgs) => TReturn | Promise<TReturn>): this;
    open(): void;
    close(): void;
    readonly opened: boolean;
    readonly closed: boolean;
    readonly halfOpen: boolean;
    readonly pendingClose: boolean;
  }

  export default CircuitBreaker;
}
