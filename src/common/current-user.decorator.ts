import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestUser } from './request-user';

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestUser => {
  return ctx.switchToHttp().getRequest().user;
});
