import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';

/** Logs method, route, status and latency only. Bodies and headers are never logged (passwords, tokens, PII). */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const route = request.route?.path ?? request.url;
    const started = Date.now();
    return next.handle().pipe(
      tap({
        next: () => this.logger.log(`${request.method} ${route} ${http.getResponse().statusCode} ${Date.now() - started}ms`),
        error: (err) => this.logger.warn(`${request.method} ${route} failed (${err?.status ?? 500}) ${Date.now() - started}ms`),
      }),
    );
  }
}
