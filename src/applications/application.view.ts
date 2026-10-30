import { RequestUser } from '../common/request-user';
import { UserRole } from '../users/user.entity';
import { MerchantApplication } from './merchant-application.entity';

/**
 * Role-aware representation of an application. SALES sees the risk *status* (they need to know
 * whether the application is moving) but not the provider's detailed result, e.g. watchlist reasons,
 * which would amount to tipping off the merchant.
 */
export function presentApplication(app: MerchantApplication, actor: RequestUser) {
  if (actor.role === UserRole.SALES) return { ...app, riskResult: null };
  return app;
}

export function presentPage<T extends { items: MerchantApplication[] }>(page: T, actor: RequestUser) {
  return { ...page, items: page.items.map((item) => presentApplication(item, actor)) };
}
